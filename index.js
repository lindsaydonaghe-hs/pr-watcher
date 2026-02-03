#!/usr/bin/env node

/**
 * PR Watcher MCP Server
 * 
 * Watches GitHub PRs for:
 * - Cursorbot review comments
 * - Buildkite/Trunk CI failures
 * 
 * Tools:
 * - watch_pr: Configure which PR to watch
 * - check_for_issues: Poll for new issues
 * - get_issue_details: Get full context for an issue
 * - mark_issue_handled: Track handled issues
 */

// Load .env file from the same directory as this script
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Octokit } from 'octokit';

// State
let watchedPR = null;
let handledIssueIds = new Set();
let lastCheckTime = null;

// GitHub client (uses GITHUB_TOKEN env var)
const octokit = new Octokit({ 
  auth: process.env.GITHUB_TOKEN 
});

/**
 * Parse PR URL or reference into owner/repo/number
 */
function parsePRReference(ref) {
  // Handle full URL: https://github.com/owner/repo/pull/123
  const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3]) };
  }
  
  // Handle short form: owner/repo#123
  const shortMatch = ref.match(/([^/]+)\/([^#]+)#(\d+)/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3]) };
  }
  
  // Handle just number (requires repo context)
  const numMatch = ref.match(/^#?(\d+)$/);
  if (numMatch) {
    return { number: parseInt(numMatch[1]) };
  }
  
  return null;
}

/**
 * Fetch cursorbot review comments (excludes outdated/resolved)
 */
async function getCursorbotComments(owner, repo, prNumber) {
  const comments = [];
  
  // Get review comments (inline code comments)
  const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
  });
  
  // Filter for cursorbot comments
  const cursorbotComments = reviewComments.filter(
    c => c.user?.login === 'cursor' || c.user?.login?.includes('cursor')
  );
  
  for (const comment of cursorbotComments) {
    // Skip outdated comments (position is null when code has changed)
    if (comment.position === null && comment.original_position !== null) {
      continue;
    }
    
    comments.push({
      id: `review-${comment.id}`,
      type: 'cursorbot',
      source: 'review_comment',
      path: comment.path,
      line: comment.line || comment.original_line,
      body: comment.body,
      url: comment.html_url,
      createdAt: comment.created_at,
      outdated: comment.position === null,
    });
  }
  
  // Also check PR review summaries
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
  });
  
  const cursorbotReviews = reviews.filter(
    r => r.user?.login === 'cursor' || r.user?.login?.includes('cursor')
  );
  
  for (const review of cursorbotReviews) {
    if (review.body) {
      comments.push({
        id: `review-summary-${review.id}`,
        type: 'cursorbot',
        source: 'review_summary',
        body: review.body,
        state: review.state,
        url: review.html_url,
        createdAt: review.submitted_at,
      });
    }
  }
  
  return comments;
}

/**
 * Fetch CI status (check runs)
 */
async function getCIStatus(owner, repo, prNumber) {
  const issues = [];
  
  // Get PR to find the head SHA
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  
  const headSha = pr.head.sha;
  
  // Get check runs for the commit
  const { data: checkRuns } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
  });
  
  for (const run of checkRuns.check_runs) {
    if (run.conclusion === 'failure' || run.conclusion === 'cancelled') {
      issues.push({
        id: `ci-${run.id}`,
        type: 'ci_failure',
        source: run.app?.name || 'CI',
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url || run.details_url,
        output: run.output?.summary || run.output?.text,
        completedAt: run.completed_at,
      });
    }
  }
  
  // Also check commit statuses (older API)
  const { data: statuses } = await octokit.rest.repos.listCommitStatusesForRef({
    owner,
    repo,
    ref: headSha,
  });
  
  for (const status of statuses) {
    if (status.state === 'failure' || status.state === 'error') {
      const statusId = `status-${status.id}`;
      // Avoid duplicates with check runs
      if (!issues.some(i => i.url === status.target_url)) {
        issues.push({
          id: statusId,
          type: 'ci_failure',
          source: status.context,
          name: status.context,
          status: status.state,
          conclusion: status.state,
          description: status.description,
          url: status.target_url,
          createdAt: status.created_at,
        });
      }
    }
  }
  
  return issues;
}

/**
 * Get all issues for a PR
 */
async function getAllIssues(owner, repo, prNumber) {
  const [cursorbotIssues, ciIssues] = await Promise.all([
    getCursorbotComments(owner, repo, prNumber),
    getCIStatus(owner, repo, prNumber),
  ]);
  
  return [...cursorbotIssues, ...ciIssues];
}

// Create MCP server
const server = new Server(
  {
    name: 'pr-watcher',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'watch_pr',
        description: 'Start watching a GitHub PR for cursorbot issues and CI failures. Provide a PR URL or reference like "owner/repo#123".',
        inputSchema: {
          type: 'object',
          properties: {
            pr: {
              type: 'string',
              description: 'PR URL (https://github.com/owner/repo/pull/123) or reference (owner/repo#123)',
            },
            owner: {
              type: 'string',
              description: 'Repository owner (optional if using full URL)',
            },
            repo: {
              type: 'string',
              description: 'Repository name (optional if using full URL)',
            },
          },
          required: ['pr'],
        },
      },
      {
        name: 'check_for_issues',
        description: 'Check the watched PR for new cursorbot comments or CI failures. Returns only issues that haven\'t been handled yet.',
        inputSchema: {
          type: 'object',
          properties: {
            include_handled: {
              type: 'boolean',
              description: 'Include already-handled issues in results',
              default: false,
            },
          },
        },
      },
      {
        name: 'get_issue_details',
        description: 'Get full details for a specific issue by ID',
        inputSchema: {
          type: 'object',
          properties: {
            issue_id: {
              type: 'string',
              description: 'The issue ID from check_for_issues',
            },
          },
          required: ['issue_id'],
        },
      },
      {
        name: 'mark_issue_handled',
        description: 'Mark an issue as handled so it won\'t appear in future checks',
        inputSchema: {
          type: 'object',
          properties: {
            issue_id: {
              type: 'string',
              description: 'The issue ID to mark as handled',
            },
          },
          required: ['issue_id'],
        },
      },
      {
        name: 'get_watched_pr',
        description: 'Get information about the currently watched PR',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'clear_handled',
        description: 'Clear the list of handled issues to see all issues again',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case 'watch_pr': {
      const parsed = parsePRReference(args.pr);
      if (!parsed) {
        return {
          content: [{ type: 'text', text: 'Invalid PR reference. Use URL or owner/repo#number format.' }],
          isError: true,
        };
      }
      
      watchedPR = {
        owner: parsed.owner || args.owner,
        repo: parsed.repo || args.repo,
        number: parsed.number,
      };
      
      if (!watchedPR.owner || !watchedPR.repo) {
        return {
          content: [{ type: 'text', text: 'Could not determine repository. Please provide owner and repo.' }],
          isError: true,
        };
      }
      
      handledIssueIds.clear();
      lastCheckTime = new Date().toISOString();
      
      // Do initial check
      const issues = await getAllIssues(watchedPR.owner, watchedPR.repo, watchedPR.number);
      
      return {
        content: [{
          type: 'text',
          text: `Now watching PR #${watchedPR.number} in ${watchedPR.owner}/${watchedPR.repo}\n\nFound ${issues.length} existing issue(s):\n${issues.map(i => `- [${i.type}] ${i.name || i.path || 'Review'}: ${(i.body || i.description || '').slice(0, 100)}...`).join('\n') || 'None'}\n\nUse check_for_issues to poll for new issues.`,
        }],
      };
    }
    
    case 'check_for_issues': {
      if (!watchedPR) {
        return {
          content: [{ type: 'text', text: 'No PR being watched. Use watch_pr first.' }],
          isError: true,
        };
      }
      
      const allIssues = await getAllIssues(watchedPR.owner, watchedPR.repo, watchedPR.number);
      const includeHandled = args?.include_handled || false;
      
      const issues = includeHandled 
        ? allIssues 
        : allIssues.filter(i => !handledIssueIds.has(i.id));
      
      lastCheckTime = new Date().toISOString();
      
      if (issues.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `✅ No ${includeHandled ? '' : 'new '}issues found on PR #${watchedPR.number}`,
          }],
        };
      }
      
      const issueList = issues.map(i => {
        const location = i.path ? `${i.path}${i.line ? `:${i.line}` : ''}` : '';
        const preview = (i.body || i.description || i.output || '').slice(0, 200);
        return `\n### ${i.type === 'cursorbot' ? '🤖 Cursorbot' : '❌ CI Failure'}: ${i.name || location || 'Issue'}\n- **ID:** ${i.id}\n- **Source:** ${i.source}\n${location ? `- **File:** ${location}\n` : ''}- **Details:** ${preview}${preview.length >= 200 ? '...' : ''}\n- **URL:** ${i.url}`;
      }).join('\n');
      
      return {
        content: [{
          type: 'text',
          text: `Found ${issues.length} issue(s) on PR #${watchedPR.number}:\n${issueList}\n\nWould you like me to fix any of these? Use mark_issue_handled to dismiss issues.`,
        }],
      };
    }
    
    case 'get_issue_details': {
      if (!watchedPR) {
        return {
          content: [{ type: 'text', text: 'No PR being watched. Use watch_pr first.' }],
          isError: true,
        };
      }
      
      const allIssues = await getAllIssues(watchedPR.owner, watchedPR.repo, watchedPR.number);
      const issue = allIssues.find(i => i.id === args.issue_id);
      
      if (!issue) {
        return {
          content: [{ type: 'text', text: `Issue ${args.issue_id} not found.` }],
          isError: true,
        };
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(issue, null, 2),
        }],
      };
    }
    
    case 'mark_issue_handled': {
      handledIssueIds.add(args.issue_id);
      return {
        content: [{
          type: 'text',
          text: `Marked ${args.issue_id} as handled. It won't appear in future checks.`,
        }],
      };
    }
    
    case 'get_watched_pr': {
      if (!watchedPR) {
        return {
          content: [{ type: 'text', text: 'No PR currently being watched.' }],
        };
      }
      
      return {
        content: [{
          type: 'text',
          text: `Watching: ${watchedPR.owner}/${watchedPR.repo}#${watchedPR.number}\nLast check: ${lastCheckTime}\nHandled issues: ${handledIssueIds.size}`,
        }],
      };
    }
    
    case 'clear_handled': {
      const count = handledIssueIds.size;
      handledIssueIds.clear();
      return {
        content: [{
          type: 'text',
          text: `Cleared ${count} handled issue(s). All issues will appear in next check.`,
        }],
      };
    }
    
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PR Watcher MCP server running');
}

main().catch(console.error);
