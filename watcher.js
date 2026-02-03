#!/usr/bin/env node

/**
 * PR Watcher - Terminal-based polling script
 * 
 * Run this in a Cursor terminal to get notifications when issues appear.
 * Usage: node watcher.js owner/repo#123
 * 
 * Token is loaded from .env file in this directory, or GITHUB_TOKEN env var.
 */

// Load .env file from the same directory as this script
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '.env') });

import { Octokit } from 'octokit';
import { readdirSync, readFileSync, existsSync } from 'fs';
import * as readline from 'readline';

const WATCHERS_DIR = join(__dirname, '.watchers');

const POLL_INTERVAL_MS = 30000; // 30 seconds

// Bot usernames to watch for review comments
const REVIEW_BOTS = [
  'cursor',           // Cursorbot
  'codex-connector',  // chatgpt-codex-connector
  'codex',            // Other potential Codex bots
];

// CI checks that are non-blocking (notifications, optional checks, etc.)
// These will be shown but won't prevent "ready to merge" status
// Can also be set via NON_BLOCKING_CI env var (comma-separated patterns)
const DEFAULT_NON_BLOCKING_CI = [
  'slack',                    // Slack notifications
  'notification',             // Generic notification jobs
  'emoji',                    // Emoji reaction jobs
  'add reaction',             // Slack reaction jobs
  'coverage',                 // Coverage reports (informational)
  'codecov',                  // Codecov reporting
  'deque_notify',             // Merge queue dequeue notifications
  'dequeue',                  // Dequeue-related jobs
];

/**
 * Get non-blocking CI patterns (defaults + env var)
 */
function getNonBlockingPatterns() {
  const patterns = [...DEFAULT_NON_BLOCKING_CI];
  
  // Add patterns from env var if set
  const envPatterns = process.env.NON_BLOCKING_CI;
  if (envPatterns) {
    patterns.push(...envPatterns.split(',').map(p => p.trim().toLowerCase()));
  }
  
  return patterns;
}

/**
 * Check if a CI job name is non-blocking
 */
function isNonBlockingCI(jobName) {
  if (!jobName) return false;
  const lower = jobName.toLowerCase();
  const patterns = getNonBlockingPatterns();
  return patterns.some(pattern => lower.includes(pattern));
}

/**
 * Check if a username belongs to a known review bot
 */
function isReviewBot(username) {
  if (!username) return false;
  const lower = username.toLowerCase();
  return REVIEW_BOTS.some(bot => lower.includes(bot));
}

/**
 * Generate a ready-to-paste prompt for Cursor to fix the issues
 */
function generateFixPrompt(issues) {
  const reviewBotIssues = issues.filter(i => i.type === 'review_bot' || i.type === 'cursorbot');
  const ciIssues = issues.filter(i => i.type === 'ci_failure');
  
  // Group review bot issues by bot type
  const cursorIssues = reviewBotIssues.filter(i => i.botType !== 'codex');
  const codexIssues = reviewBotIssues.filter(i => i.botType === 'codex');
  
  let prompt = `Fix these PR issues:\n\n`;
  
  if (cursorIssues.length > 0) {
    prompt += `**Cursorbot Issues:**\n`;
    for (const issue of cursorIssues) {
      const location = issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ''}` : '';
      const severityMatch = issue.body?.match(/(High|Medium|Low)\s+Severity/i);
      const severity = severityMatch ? `[${severityMatch[1]}] ` : '';
      const titleMatch = issue.body?.match(/^#+\s*(.+)$/m) || issue.body?.match(/^\*\*(.+?)\*\*/m);
      const title = titleMatch ? titleMatch[1].slice(0, 80) : (issue.body?.split('\n')[0]?.slice(0, 80) || 'Issue');
      
      prompt += `- ${severity}${title}\n`;
      if (location) prompt += `  File: ${location}\n`;
    }
    prompt += `\n`;
  }
  
  if (codexIssues.length > 0) {
    prompt += `**Codex Review Issues:**\n`;
    for (const issue of codexIssues) {
      const location = issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ''}` : '';
      const priorityMatch = issue.body?.match(/[🔴🟡🟢]?\s*(P[0-2])\b/i);
      const priority = priorityMatch ? `[${priorityMatch[1].toUpperCase()}] ` : '';
      const titleMatch = issue.body?.match(/^#+\s*(.+)$/m) || issue.body?.match(/^\*\*(.+?)\*\*/m);
      const title = titleMatch ? titleMatch[1].slice(0, 80) : (issue.body?.split('\n')[0]?.slice(0, 80) || 'Issue');
      
      prompt += `- ${priority}${title}\n`;
      if (location) prompt += `  File: ${location}\n`;
    }
    prompt += `\n`;
  }
  
  // Only include blocking CI failures in the prompt
  const blockingCIIssues = ciIssues.filter(i => !i.nonBlocking);
  const nonBlockingCIIssues = ciIssues.filter(i => i.nonBlocking);
  
  if (blockingCIIssues.length > 0) {
    prompt += `**CI Failures:**\n`;
    for (const issue of blockingCIIssues) {
      const ciName = issue.name || issue.source || 'CI';
      prompt += `- ${ciName}: ${issue.description || 'Build failed'}\n`;
      if (issue.url) prompt += `  URL: ${issue.url}\n`;
    }
    prompt += `\nFor CI details, run: bklog <URL>\n`;
  }
  
  if (nonBlockingCIIssues.length > 0) {
    prompt += `\n*Note: ${nonBlockingCIIssues.length} non-blocking CI failure(s) (Slack notifications, etc.) - these won't prevent merge.*\n`;
  }
  
  prompt += `\nAfter fixing, commit and push the changes.`;
  
  return prompt;
}

/**
 * Copy text to clipboard using pbcopy
 */
async function copyToClipboard(text) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  try {
    // Use echo with pbcopy to copy to clipboard
    await execAsync(`echo "${text.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" | pbcopy`);
    return true;
  } catch (error) {
    // Try alternative method with heredoc (handles special chars better)
    try {
      await execAsync(`pbcopy <<'CLIPBOARD_EOF'\n${text}\nCLIPBOARD_EOF`);
      return true;
    } catch (e) {
      return false;
    }
  }
}

/**
 * Send macOS notification for new issues
 */
async function sendNotification(issues) {
  const { exec } = await import('child_process');
  
  // Generate the fix prompt
  const fixPrompt = generateFixPrompt(issues);
  
  // Copy to clipboard
  const copied = await copyToClipboard(fixPrompt);
  
  // Build notification message
  const count = issues.length;
  const firstIssue = issues[0];
  
  // Extract title/summary from first issue
  const titleMatch = firstIssue.body?.match(/^#+\s*(.+)$/m) || firstIssue.body?.match(/^\*\*(.+?)\*\*/m);
  const title = titleMatch ? titleMatch[1].slice(0, 40) : (firstIssue.path || 'PR Issue');
  
  // Extract severity
  const severityMatch = firstIssue.body?.match(/(High|Medium|Low)\s+Severity/i);
  const severity = severityMatch ? `[${severityMatch[1]}] ` : '';
  
  const subtitle = count > 1 ? `${count} issues on PR #${prInfo.number}` : `Issue on PR #${prInfo.number}`;
  const clipboardNote = copied ? ' (prompt copied to clipboard)' : '';
  const message = `${severity}${title}${clipboardNote}`;
  
  // Use osascript for native macOS notification
  const script = `display notification "${message.replace(/"/g, '\\"')}" with title "PR Watcher" subtitle "${subtitle}"`;
  
  exec(`osascript -e '${script}'`, (error) => {
    if (error) {
      // Silently fail - notification is not critical
    }
  });
  
  // Also print the prompt to terminal for reference
  if (copied) {
    console.log(`\n${COLORS.green}📋 Fix prompt copied to clipboard!${COLORS.reset}`);
    console.log(`${COLORS.blue}Open Cursor chat (Cmd+L) and paste (Cmd+V) to fix issues.${COLORS.reset}\n`);
  }
}

/**
 * Send "ready to merge" notification
 */
async function sendReadyToMergeNotification() {
  const { exec } = await import('child_process');
  
  const subtitle = `PR #${prInfo.number} is ready!`;
  const message = `All checks passed, no review issues`;
  
  // Use osascript for native macOS notification with a sound
  const script = `display notification "${message}" with title "✅ Ready to Merge" subtitle "${subtitle}" sound name "Glass"`;
  
  exec(`osascript -e '${script}'`, (error) => {
    if (error) {
      // Silently fail - notification is not critical
    }
  });
  
  // Also play the bell
  process.stdout.write('\x07');
}
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// GitHub client
const octokit = new Octokit({ 
  auth: process.env.GITHUB_TOKEN 
});

// State
let seenIssueIds = new Set();
let prInfo = null;
let previouslyHadBlockingIssues = false;  // Track if we had blocking issues on last poll
let notifiedReadyToMerge = false;         // Don't spam "ready to merge" notifications
let lastMergeQueueState = null;           // Track merge queue state for notifications
let prUrl = null;                          // Cache the PR URL

/**
 * Parse PR URL or reference
 */
function parsePRReference(ref) {
  const urlMatch = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: parseInt(urlMatch[3]) };
  }
  
  const shortMatch = ref.match(/([^/]+)\/([^#]+)#(\d+)/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], number: parseInt(shortMatch[3]) };
  }
  
  return null;
}

/**
 * Fetch cursor bot review comments using GraphQL (properly handles resolved/outdated)
 */
async function getCursorbotComments(owner, repo, prNumber) {
  const comments = [];
  
  try {
    // Use GraphQL to get review threads with resolved status
    // Note: GitHub treats "dismissed" the same as "resolved" (isResolved = true)
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                resolvedBy {
                  login
                }
                path
                line
                comments(first: 10) {
                  nodes {
                    id
                    databaseId
                    body
                    url
                    author {
                      login
                    }
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const result = await octokit.graphql(query, { owner, repo, prNumber });
    const threads = result.repository?.pullRequest?.reviewThreads?.nodes || [];
    
    // Debug on first check
    if (seenIssueIds.size === 0) {
      const allAuthors = new Set();
      let resolvedCount = 0;
      let outdatedCount = 0;
      
      for (const thread of threads) {
        if (thread.isResolved) resolvedCount++;
        if (thread.isOutdated) outdatedCount++;
        for (const comment of thread.comments?.nodes || []) {
          if (comment.author?.login) {
            allAuthors.add(comment.author.login);
          }
        }
      }
      
      console.log(`\n${COLORS.blue}Debug: Review thread authors:${COLORS.reset} ${[...allAuthors].join(', ')}`);
      console.log(`${COLORS.blue}Debug: ${threads.length} threads total, ${resolvedCount} resolved, ${outdatedCount} outdated${COLORS.reset}`);
    }
    
    // Process threads
    for (const thread of threads) {
      // Skip resolved or outdated threads
      if (thread.isResolved || thread.isOutdated) {
        continue;
      }
      
      // Get review bot comments from this thread (cursorbot, codex, etc.)
      const botComments = (thread.comments?.nodes || []).filter(
        c => isReviewBot(c.author?.login)
      );
      
      for (const comment of botComments) {
        // Determine which bot this is from
        const author = comment.author?.login || 'bot';
        const botType = author.toLowerCase().includes('codex') ? 'codex' : 'cursorbot';
        
        comments.push({
          id: `review-${comment.databaseId}`,
          type: 'review_bot',
          botType: botType,
          path: thread.path,
          line: thread.line,
          body: comment.body,
          url: comment.url,
          author: author,
          createdAt: comment.createdAt,
          resolved: thread.isResolved,
          outdated: thread.isOutdated,
        });
      }
    }
  } catch (e) {
    console.error('Error fetching review comments:', e.message);
    // Fallback to REST API if GraphQL fails
    console.log(`${COLORS.yellow}Falling back to REST API...${COLORS.reset}`);
    return getCursorbotCommentsREST(owner, repo, prNumber);
  }
  
  return comments;
}

/**
 * Fallback REST API method
 */
async function getCursorbotCommentsREST(owner, repo, prNumber) {
  const comments = [];
  
  try {
    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
    });
    
    const botComments = reviewComments.filter(
      c => isReviewBot(c.user?.login)
    );
    
    for (const comment of botComments) {
      const isOutdated = comment.position === null && comment.original_position !== null;
      if (isOutdated) continue; // Skip outdated in fallback
      
      const author = comment.user?.login || 'bot';
      const botType = author.toLowerCase().includes('codex') ? 'codex' : 'cursorbot';
      
      comments.push({
        id: `review-${comment.id}`,
        type: 'review_bot',
        botType: botType,
        path: comment.path,
        line: comment.line || comment.original_line,
        body: comment.body,
        url: comment.html_url,
        author: author,
        createdAt: comment.created_at,
      });
    }
  } catch (e) {
    console.error('Error in REST fallback:', e.message);
  }
  
  return comments;
}

/**
 * Fetch CI failures (GitHub Check Runs + Commit Statuses)
 */
async function getCIFailures(owner, repo, prNumber) {
  const issues = [];
  
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    
    const headSha = pr.head.sha;
    
    // Get GitHub Check Runs
    const { data: checkRuns } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
    });
    
    // Debug on first check
    if (seenIssueIds.size === 0) {
      const checkSummary = checkRuns.check_runs.map(r => 
        `${r.name}: ${r.status}/${r.conclusion || 'pending'}`
      );
      console.log(`${COLORS.blue}Debug: ${checkRuns.total_count} check runs:${COLORS.reset}`);
      checkSummary.forEach(s => console.log(`  - ${s}`));
    }
    
    for (const run of checkRuns.check_runs) {
      if (run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out') {
        issues.push({
          id: `ci-${run.id}`,
          type: 'ci_failure',
          name: run.name,
          source: run.app?.name || 'CI',
          conclusion: run.conclusion,
          url: run.html_url || run.details_url,
          output: run.output?.summary || run.output?.title,
          nonBlocking: isNonBlockingCI(run.name),
        });
      }
    }
    
    // Also get Commit Statuses (older API, used by some CI systems like Buildkite)
    const { data: statusData } = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
    });
    
    // Debug on first check - show full status details
    if (seenIssueIds.size === 0) {
      console.log(`${COLORS.blue}Debug: Combined status: ${statusData.state}, ${statusData.statuses.length} statuses:${COLORS.reset}`);
      statusData.statuses.forEach(s => {
        console.log(`  - ${s.context}: ${s.state}`);
        if (s.description) console.log(`    Description: ${s.description}`);
        if (s.target_url) console.log(`    URL: ${s.target_url}`);
      });
    }
    
    for (const status of statusData.statuses) {
      if (status.state === 'failure' || status.state === 'error') {
        // Check if we already have this from check runs (avoid duplicates)
        const isDuplicate = issues.some(i => 
          i.url === status.target_url || 
          i.name?.toLowerCase() === status.context?.toLowerCase()
        );
        
        if (!isDuplicate) {
          issues.push({
            id: `status-${status.id}`,
            type: 'ci_failure',
            name: status.context,
            source: status.context?.split('/')[0] || 'CI',
            conclusion: status.state,
            description: status.description,
            url: status.target_url,
            nonBlocking: isNonBlockingCI(status.context),
          });
        }
      }
    }
  } catch (e) {
    console.error('Error fetching CI status:', e.message);
  }
  
  return issues;
}

/**
 * Check if all CI checks are green (passed, not pending or failing)
 * Non-blocking checks (Slack notifications, etc.) are tracked separately
 * Returns: { allGreen: boolean, pending: number, passed: number, failed: number, nonBlockingFailed: number }
 */
async function checkCIStatus(owner, repo, prNumber) {
  const result = { 
    allGreen: false, 
    pending: 0, 
    passed: 0, 
    failed: 0,           // Blocking failures
    nonBlockingFailed: 0, // Non-blocking failures (notifications, etc.)
    total: 0 
  };
  
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    
    const headSha = pr.head.sha;
    
    // Get GitHub Check Runs
    const { data: checkRuns } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
    });
    
    for (const run of checkRuns.check_runs) {
      result.total++;
      if (run.status !== 'completed') {
        result.pending++;
      } else if (run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral') {
        result.passed++;
      } else {
        // Check if this is a non-blocking failure
        if (isNonBlockingCI(run.name)) {
          result.nonBlockingFailed++;
        } else {
          result.failed++;
        }
      }
    }
    
    // Also check Commit Statuses
    const { data: statusData } = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
    });
    
    for (const status of statusData.statuses) {
      result.total++;
      if (status.state === 'pending') {
        result.pending++;
      } else if (status.state === 'success') {
        result.passed++;
      } else {
        // Check if this is a non-blocking failure
        if (isNonBlockingCI(status.context)) {
          result.nonBlockingFailed++;
        } else {
          result.failed++;
        }
      }
    }
    
    // All green if we have checks, none pending, no BLOCKING failures
    // Non-blocking failures are okay
    result.allGreen = result.total > 0 && result.pending === 0 && result.failed === 0;
    
  } catch (e) {
    console.error('Error checking CI status:', e.message);
  }
  
  return result;
}

/**
 * Get PR URL
 */
function getPRUrl() {
  if (!prInfo) return null;
  return `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;
}

/**
 * Check merge queue status for the PR
 * Returns: { inQueue: boolean, position: number|null, state: string|null, estimatedMergeTime: string|null, ... }
 */
async function checkMergeQueueStatus(owner, repo, prNumber) {
  const result = { 
    inQueue: false, 
    position: null, 
    state: null,           // QUEUED, AWAITING_CHECKS, MERGEABLE, UNMERGEABLE, LOCKED
    estimatedMergeTime: null,
    merged: false,
    aheadCount: null,      // How many PRs ahead in queue
    displayState: null,    // Human-friendly state description
  };
  
  try {
    // First check if PR is merged
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    
    if (pr.merged) {
      result.merged = true;
      result.state = 'MERGED';
      result.displayState = 'Merged!';
      return result;
    }
    
    // Use GraphQL to check merge queue status with more details
    const query = `
      query($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            mergeQueueEntry {
              position
              state
              estimatedTimeToMerge
              enqueuedAt
              baseCommit {
                oid
              }
            }
          }
        }
      }
    `;
    
    const response = await octokit.graphql(query, { owner, repo, prNumber });
    const entry = response.repository?.pullRequest?.mergeQueueEntry;
    
    if (entry) {
      result.inQueue = true;
      result.position = entry.position;
      result.state = entry.state;
      result.estimatedMergeTime = entry.estimatedTimeToMerge;
      
      // Calculate how many PRs are ahead (position is 0-indexed, so position 0 = next to merge)
      result.aheadCount = entry.position || 0;
      
      // Create human-friendly display state
      if (entry.state === 'MERGEABLE') {
        result.displayState = 'Ready to merge (at front of queue)';
      } else if (entry.state === 'AWAITING_CHECKS') {
        if (result.aheadCount > 0) {
          result.displayState = `Waiting (${result.aheadCount} PR${result.aheadCount > 1 ? 's' : ''} ahead)`;
        } else {
          result.displayState = 'Running checks (at front of queue)';
        }
      } else if (entry.state === 'QUEUED') {
        if (result.aheadCount > 0) {
          result.displayState = `In queue (${result.aheadCount} PR${result.aheadCount > 1 ? 's' : ''} ahead)`;
        } else {
          result.displayState = 'In queue (next up)';
        }
      } else if (entry.state === 'UNMERGEABLE') {
        // UNMERGEABLE can mean conflicts OR just waiting for PRs ahead
        if (result.aheadCount > 0) {
          result.displayState = `Waiting (${result.aheadCount} PR${result.aheadCount > 1 ? 's' : ''} ahead)`;
        } else {
          result.displayState = 'Cannot merge (check for conflicts)';
        }
      } else if (entry.state === 'LOCKED') {
        result.displayState = 'Queue is locked';
      } else {
        result.displayState = entry.state;
      }
      
      // Add ETA if available
      if (entry.estimatedTimeToMerge) {
        const eta = new Date(entry.estimatedTimeToMerge);
        const now = new Date();
        const diffMs = eta - now;
        if (diffMs > 0) {
          const diffMins = Math.round(diffMs / 60000);
          if (diffMins < 60) {
            result.displayState += ` (~${diffMins}m)`;
          } else {
            const hours = Math.floor(diffMins / 60);
            const mins = diffMins % 60;
            result.displayState += ` (~${hours}h ${mins}m)`;
          }
        }
      }
    }
  } catch (e) {
    // GraphQL may fail if merge queues aren't enabled - that's okay
    if (!e.message?.includes('Could not resolve')) {
      console.error('Error checking merge queue:', e.message);
    }
  }
  
  return result;
}

/**
 * Send merge queue notification
 */
async function sendMergeQueueNotification(state, message) {
  const { exec } = await import('child_process');
  
  const subtitle = `PR #${prInfo.number}`;
  let title, sound;
  
  if (state === 'MERGED') {
    title = '🎉 PR Merged!';
    sound = 'Glass';
  } else if (state === 'REMOVED') {
    title = '⚠️ Removed from Queue';
    sound = 'Basso';
  } else if (state === 'QUEUED') {
    title = '📋 Added to Queue';
    sound = 'Pop';
  } else {
    title = '📋 Merge Queue Update';
    sound = 'Pop';
  }
  
  const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title}" subtitle "${subtitle}" sound name "${sound}"`;
  
  exec(`osascript -e '${script}'`, (error) => {
    if (error) {
      // Silently fail
    }
  });
  
  process.stdout.write('\x07');
}

/**
 * Print a notification for an issue
 */
function printNotification(issue, isNew = true) {
  const prefix = isNew ? `${COLORS.bright}${COLORS.yellow}🔔 NEW ISSUE${COLORS.reset}` : '';
  const typeColor = issue.type === 'cursorbot' ? COLORS.cyan : COLORS.red;
  const typeIcon = issue.type === 'cursorbot' ? '🤖' : '❌';
  const outdatedTag = issue.outdated ? ` ${COLORS.yellow}[OUTDATED]${COLORS.reset}` : '';
  
  console.log('\n' + '='.repeat(70));
  if (isNew) console.log(prefix);
  console.log(`${typeColor}${typeIcon} ${issue.type.toUpperCase()}${COLORS.reset}: ${issue.name || issue.path || 'Issue'}${outdatedTag}`);
  console.log(`${COLORS.blue}ID:${COLORS.reset} ${issue.id}`);
  if (issue.path) console.log(`${COLORS.blue}File:${COLORS.reset} ${issue.path}${issue.line ? `:${issue.line}` : ''}`);
  if (issue.source) console.log(`${COLORS.blue}Source:${COLORS.reset} ${issue.source}`);
  if (issue.body) {
    console.log(`${COLORS.blue}Details:${COLORS.reset}`);
    console.log(issue.body.slice(0, 500) + (issue.body.length > 500 ? '...' : ''));
  }
  if (issue.output) {
    console.log(`${COLORS.blue}Output:${COLORS.reset}`);
    console.log(issue.output.slice(0, 300) + (issue.output.length > 300 ? '...' : ''));
  }
  console.log(`${COLORS.blue}URL:${COLORS.reset} ${issue.url}`);
  console.log('='.repeat(70));
  
  // Print action prompt (skip for outdated)
  if (isNew && !issue.outdated) {
    console.log(`\n${COLORS.green}>>> Ask Cursor: "Fix issue ${issue.id}"${COLORS.reset}`);
  }
}

/**
 * Fetch PR issue comments from cursor bot (general comments, not inline)
 */
async function getPRIssueComments(owner, repo, prNumber) {
  const comments = [];
  
  try {
    const { data: issueComments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });
    
    // Only get cursor bot comments
    const cursorComments = issueComments.filter(
      c => c.user?.login?.toLowerCase().includes('cursor')
    );
    
    for (const comment of cursorComments) {
      comments.push({
        id: `issue-${comment.id}`,
        type: 'cursorbot',
        name: 'PR Comment',
        body: comment.body,
        url: comment.html_url,
        author: comment.user?.login,
      });
    }
  } catch (e) {
    console.error('Error fetching issue comments:', e.message);
  }
  
  return comments;
}

/**
 * Get list of all running watchers
 */
function getRunningWatchers() {
  const watchers = [];
  
  if (!existsSync(WATCHERS_DIR)) {
    return watchers;
  }
  
  try {
    const files = readdirSync(WATCHERS_DIR);
    const pidFiles = files.filter(f => f.endsWith('.pid'));
    
    for (const pidFile of pidFiles) {
      const pidPath = join(WATCHERS_DIR, pidFile);
      const refPath = join(WATCHERS_DIR, pidFile.replace('.pid', '.ref'));
      
      try {
        const pid = readFileSync(pidPath, 'utf-8').trim();
        
        // Check if process is running (simple check - may not be 100% accurate)
        try {
          process.kill(parseInt(pid), 0);
          // Process exists
          const prRef = existsSync(refPath) 
            ? readFileSync(refPath, 'utf-8').trim() 
            : pidFile.replace('.pid', '').replace(/-/g, '/').replace(/\/(\d+)$/, '#$1');
          watchers.push({ prRef, pid });
        } catch (e) {
          // Process not running - skip
        }
      } catch (e) {
        // File read error - skip
      }
    }
  } catch (e) {
    // Directory read error - skip
  }
  
  return watchers;
}

/**
 * Clear terminal and print header
 */
function clearAndPrintHeader() {
  // Clear terminal
  process.stdout.write('\x1B[2J\x1B[0f');
  
  // Get all running watchers
  const allWatchers = getRunningWatchers();
  const otherWatchers = allWatchers.filter(w => 
    w.prRef !== `${prInfo.owner}/${prInfo.repo}#${prInfo.number}`
  );
  
  console.log(`${COLORS.bright}PR Watcher${COLORS.reset} - ${prInfo.owner}/${prInfo.repo}#${prInfo.number}`);
  console.log(`${COLORS.blue}URL:${COLORS.reset} ${getPRUrl()}  ${COLORS.cyan}(u=copy)${COLORS.reset}`);
  
  // Show other running watchers if any
  if (otherWatchers.length > 0) {
    const otherPRs = otherWatchers.map(w => {
      // Shorten the display (just repo#number)
      const match = w.prRef.match(/([^/]+)#(\d+)$/);
      return match ? `${match[1]}#${match[2]}` : w.prRef;
    }).join(', ');
    console.log(`${COLORS.blue}Also watching:${COLORS.reset} ${otherPRs}`);
  }
  
  console.log(`${COLORS.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
}

/**
 * Poll for issues
 */
async function pollForIssues() {
  const timestamp = new Date().toLocaleTimeString();
  
  const [cursorbotIssues, issueComments, ciIssues] = await Promise.all([
    getCursorbotComments(prInfo.owner, prInfo.repo, prInfo.number),
    getPRIssueComments(prInfo.owner, prInfo.repo, prInfo.number),
    getCIFailures(prInfo.owner, prInfo.repo, prInfo.number),
  ]);
  
  const allIssues = [...cursorbotIssues, ...issueComments, ...ciIssues];
  const newIssues = allIssues.filter(i => !seenIssueIds.has(i.id));
  
  // Check merge queue status
  const mergeQueueStatus = await checkMergeQueueStatus(prInfo.owner, prInfo.repo, prInfo.number);
  
  // Clear and refresh display
  clearAndPrintHeader();
  console.log(`${COLORS.blue}Last checked:${COLORS.reset} ${timestamp}\n`);
  
  // Show new issues notification prominently at top
  const newBlockingIssues = newIssues.filter(i => !i.nonBlocking);
  const newNonBlockingIssues = newIssues.filter(i => i.nonBlocking);
  
  if (newBlockingIssues.length > 0) {
    console.log(`${COLORS.bright}${COLORS.yellow}🔔 ${newBlockingIssues.length} new blocking issue(s) detected!${COLORS.reset}`);
    process.stdout.write('\x07'); // Bell sound
    await sendNotification(newBlockingIssues);
    notifiedReadyToMerge = false;
  } else if (newNonBlockingIssues.length > 0) {
    console.log(`${COLORS.yellow}ℹ️  ${newNonBlockingIssues.length} new non-blocking issue(s) (won't prevent merge)${COLORS.reset}`);
  }
  
  console.log('');
  
  // Store issues for detail lookup
  globalThis.currentIssues = allIssues;
  
  // Show current active issues
  if (allIssues.length === 0) {
    console.log(`${COLORS.green}✅ No active issues!${COLORS.reset}`);
    console.log(`${COLORS.magenta}Keys:${COLORS.reset} ${COLORS.cyan}c${COLORS.reset}=copy issues  ${COLORS.cyan}u${COLORS.reset}=copy URL  ${COLORS.cyan}r${COLORS.reset}=refresh  ${COLORS.cyan}q${COLORS.reset}=quit`);
  } else {
    console.log(`${COLORS.yellow}📋 ${allIssues.length} active issue(s):${COLORS.reset}\n`);
    
    for (const issue of allIssues) {
      const isNew = !seenIssueIds.has(issue.id);
      const newTag = isNew ? ` ${COLORS.bright}${COLORS.yellow}← NEW${COLORS.reset}` : '';
      
      if (issue.type === 'ci_failure') {
        // CI failure display
        const ciName = issue.name || issue.source || 'CI';
        const description = issue.description || issue.output || 'Build failed';
        
        if (issue.nonBlocking) {
          // Non-blocking CI failure (Slack notifications, etc.) - show dimmed
          console.log(`  ⚠️  ${COLORS.yellow}[CI-optional]${COLORS.reset} ${COLORS.cyan}${issue.id}${COLORS.reset}${newTag}`);
          console.log(`     ${ciName} ${COLORS.yellow}(non-blocking)${COLORS.reset}`);
        } else {
          // Blocking CI failure
          console.log(`  ❌ ${COLORS.red}[CI]${COLORS.reset} ${COLORS.cyan}${issue.id}${COLORS.reset}${newTag}`);
          console.log(`     ${COLORS.bright}${ciName}${COLORS.reset}`);
          console.log(`     ${description}`);
          if (issue.url) {
            console.log(`     ${COLORS.blue}${issue.url}${COLORS.reset}`);
          }
        }
      } else {
        // Review bot issue display (cursorbot, codex, etc.)
        const location = issue.path ? `${issue.path}${issue.line ? `:${issue.line}` : ''}` : 'PR Comment';
        
        // Determine bot icon and label
        const botIcon = issue.botType === 'codex' ? '🧠' : '🤖';
        const botLabel = issue.botType === 'codex' ? 'CODEX' : 'CURSOR';
        
        // Extract title from body (first line or heading)
        const titleMatch = issue.body?.match(/^#+\s*(.+)$/m) || issue.body?.match(/^\*\*(.+?)\*\*/m);
        const title = titleMatch ? titleMatch[1].slice(0, 50) : (issue.body?.split('\n')[0]?.slice(0, 50) || 'Issue');
        
        // Extract severity/priority from body (Codex uses P0, P1, P2 format)
        const severityMatch = issue.body?.match(/\*\*(High|Medium|Low)\s+Severity\*\*/i) || 
                             issue.body?.match(/(High|Medium|Low)\s+Severity/i);
        const priorityMatch = issue.body?.match(/[🔴🟡🟢]?\s*(P[0-2])\b/i);
        
        let severityTag = '';
        if (severityMatch) {
          const sev = severityMatch[1].toLowerCase();
          if (sev === 'high') severityTag = `${COLORS.red}[HIGH]${COLORS.reset} `;
          else if (sev === 'medium') severityTag = `${COLORS.yellow}[MED]${COLORS.reset} `;
          else severityTag = `${COLORS.blue}[LOW]${COLORS.reset} `;
        } else if (priorityMatch) {
          const pri = priorityMatch[1].toUpperCase();
          if (pri === 'P0') severityTag = `${COLORS.red}[P0]${COLORS.reset} `;
          else if (pri === 'P1') severityTag = `${COLORS.yellow}[P1]${COLORS.reset} `;
          else severityTag = `${COLORS.blue}[P2]${COLORS.reset} `;
        }
        
        console.log(`  ${botIcon} ${COLORS.magenta}[${botLabel}]${COLORS.reset} ${severityTag}${COLORS.cyan}${issue.id}${COLORS.reset}${newTag}`);
        console.log(`     ${title}${title.length >= 50 ? '...' : ''}`);
        console.log(`     ${COLORS.blue}${location}${COLORS.reset}`);
      }
      console.log('');
    }
    
    console.log(`${COLORS.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
    console.log(`${COLORS.magenta}Tip:${COLORS.reset} Run ${COLORS.cyan}prdetail <ID>${COLORS.reset} for full details`);
    
    // Check if there are CI failures
    const ciFailures = allIssues.filter(i => i.type === 'ci_failure');
    if (ciFailures.length > 0) {
      console.log(`${COLORS.magenta}CI:${COLORS.reset}  Run ${COLORS.cyan}bklog <URL>${COLORS.reset} for Buildkite failure details`);
    }
    
    // Show shortcuts here with the tips
    console.log(`${COLORS.magenta}Keys:${COLORS.reset} ${COLORS.cyan}c${COLORS.reset}=copy issues  ${COLORS.cyan}u${COLORS.reset}=copy URL  ${COLORS.cyan}r${COLORS.reset}=refresh  ${COLORS.cyan}q${COLORS.reset}=quit`);
  }
  
  // Update seen issues
  for (const issue of allIssues) {
    seenIssueIds.add(issue.id);
  }
  
  // ========== STATUS SECTION (always at bottom) ==========
  console.log(`${COLORS.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  
  // Check CI and blocking issues status
  const blockingIssues = allIssues.filter(i => !i.nonBlocking);
  const hasBlockingIssues = blockingIssues.length > 0;
  const nonBlockingCount = allIssues.length - blockingIssues.length;
  const ciStatus = await checkCIStatus(prInfo.owner, prInfo.repo, prInfo.number);
  
  // Build CI status message
  let ciStatusMsg = '';
  if (ciStatus.allGreen) {
    ciStatusMsg = `✅ ${ciStatus.passed} checks passed`;
    if (ciStatus.nonBlockingFailed > 0 || nonBlockingCount > 0) {
      ciStatusMsg += ` (${ciStatus.nonBlockingFailed + nonBlockingCount} non-blocking failed)`;
    }
  } else if (ciStatus.pending > 0) {
    ciStatusMsg = `⏳ ${ciStatus.pending} check(s) pending, ${ciStatus.passed} passed`;
    if (ciStatus.failed > 0) {
      ciStatusMsg += `, ${ciStatus.failed} failed`;
    }
  } else if (ciStatus.failed > 0) {
    ciStatusMsg = `❌ ${ciStatus.failed} check(s) failed, ${ciStatus.passed} passed`;
  }
  
  // Check for merge queue state changes and send notifications
  const currentQueueState = mergeQueueStatus.merged ? 'MERGED' : 
                            mergeQueueStatus.inQueue ? mergeQueueStatus.state : null;
  
  if (lastMergeQueueState !== currentQueueState && lastMergeQueueState !== null) {
    if (currentQueueState === 'MERGED') {
      await sendMergeQueueNotification('MERGED', 'Your PR has been merged!');
    } else if (lastMergeQueueState && !currentQueueState) {
      await sendMergeQueueNotification('REMOVED', 'Check the PR - may need to re-queue');
    } else if (!lastMergeQueueState && currentQueueState) {
      const position = mergeQueueStatus.position ? ` Position: #${mergeQueueStatus.position}` : '';
      await sendMergeQueueNotification('QUEUED', `Added to merge queue${position}`);
    }
  }
  
  // Send ready notification if applicable
  if (!hasBlockingIssues && ciStatus.allGreen && !notifiedReadyToMerge) {
    if (previouslyHadBlockingIssues) {
      await sendReadyToMergeNotification();
    }
    notifiedReadyToMerge = true;
  }
  
  // Display the combined status
  if (mergeQueueStatus.merged) {
    console.log(`${COLORS.bright}${COLORS.green}🎉 PR MERGED!${COLORS.reset}`);
    console.log(`${COLORS.green}${ciStatusMsg}${COLORS.reset}`);
  } else if (mergeQueueStatus.inQueue) {
    // In merge queue - show queue status prominently
    const displayState = mergeQueueStatus.displayState || 'In queue';
    const state = mergeQueueStatus.state || 'QUEUED';
    let stateColor = state === 'MERGEABLE' ? COLORS.green : 
                     (state === 'UNMERGEABLE' && mergeQueueStatus.aheadCount === 0) ? COLORS.red : 
                     COLORS.yellow;
    
    console.log(`${COLORS.bright}📋 MERGE QUEUE:${COLORS.reset} ${stateColor}${displayState}${COLORS.reset}`);
    console.log(`${COLORS.green}${ciStatusMsg}${COLORS.reset}`);
  } else if (hasBlockingIssues) {
    // Has issues to fix
    console.log(`${COLORS.yellow}⚠️  ${blockingIssues.length} blocking issue(s) to fix${COLORS.reset}`);
    console.log(`${ciStatus.allGreen ? COLORS.green : COLORS.yellow}${ciStatusMsg}${COLORS.reset}`);
  } else if (ciStatus.allGreen) {
    // Ready to merge - not in queue yet
    console.log(`${COLORS.bright}${COLORS.green}✅ READY TO MERGE${COLORS.reset}`);
    console.log(`${COLORS.green}${ciStatusMsg}${COLORS.reset}`);
    console.log(`${COLORS.cyan}Press 'u' to copy PR URL, then add to merge queue${COLORS.reset}`);
  } else if (ciStatus.pending > 0) {
    // Waiting for CI
    console.log(`${COLORS.yellow}⏳ WAITING FOR CI${COLORS.reset}`);
    console.log(`${COLORS.yellow}${ciStatusMsg}${COLORS.reset}`);
  } else {
    // CI failed
    console.log(`${COLORS.red}❌ CI FAILING${COLORS.reset}`);
    console.log(`${COLORS.red}${ciStatusMsg}${COLORS.reset}`);
  }
  
  console.log('');
  
  lastMergeQueueState = currentQueueState;
  previouslyHadBlockingIssues = hasBlockingIssues;
}

/**
 * Copy all current issues to clipboard
 */
async function copyAllIssuesToClipboard() {
  const issues = globalThis.currentIssues || [];
  
  if (issues.length === 0) {
    console.log(`\n${COLORS.yellow}No issues to copy.${COLORS.reset}`);
    return;
  }
  
  const prompt = generateFixPrompt(issues);
  const copied = await copyToClipboard(prompt);
  
  if (copied) {
    console.log(`\n${COLORS.green}📋 Copied ${issues.length} issue(s) to clipboard!${COLORS.reset}`);
    console.log(`${COLORS.blue}Paste into Cursor chat (Cmd+L, Cmd+V) to fix.${COLORS.reset}\n`);
  } else {
    console.log(`\n${COLORS.red}Failed to copy to clipboard.${COLORS.reset}\n`);
  }
}

/**
 * Set up keyboard shortcuts
 */
function setupKeyboardShortcuts() {
  // Only set up if stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) {
    return;
  }
  
  // Enable raw mode to capture individual keypresses
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  
  process.stdin.on('keypress', async (str, key) => {
    // Handle Ctrl+C
    if (key.ctrl && key.name === 'c') {
      console.log(`\n${COLORS.yellow}Stopping watcher...${COLORS.reset}`);
      process.exit(0);
    }
    
    // Handle 'q' to quit
    if (key.name === 'q') {
      console.log(`\n${COLORS.yellow}Stopping watcher...${COLORS.reset}`);
      process.exit(0);
    }
    
    // Handle 'c' to copy all issues
    if (key.name === 'c') {
      await copyAllIssuesToClipboard();
    }
    
    // Handle 'u' to copy PR URL
    if (key.name === 'u') {
      const url = getPRUrl();
      if (url) {
        const copied = await copyToClipboard(url);
        if (copied) {
          console.log(`\n${COLORS.green}📋 PR URL copied to clipboard!${COLORS.reset}`);
          console.log(`${COLORS.blue}${url}${COLORS.reset}\n`);
        }
      }
    }
    
    // Handle 'r' to refresh now
    if (key.name === 'r') {
      console.log(`\n${COLORS.cyan}Refreshing...${COLORS.reset}`);
      await pollForIssues();
    }
  });
}

/**
 * Main entry point
 */
async function main() {
  // Get PR reference from args or env
  const prRef = process.argv[2] || process.env.PR_URL;
  
  if (!prRef) {
    console.error('Usage: node watcher.js <PR_URL or owner/repo#number>');
    console.error('  Or set PR_URL environment variable');
    console.error('\nExample:');
    console.error('  GITHUB_TOKEN=xxx node watcher.js joinhandshake/joinera#8211');
    console.error('  GITHUB_TOKEN=xxx PR_URL="https://github.com/owner/repo/pull/123" node watcher.js');
    process.exit(1);
  }
  
  if (!process.env.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }
  
  prInfo = parsePRReference(prRef);
  if (!prInfo) {
    console.error('Invalid PR reference:', prRef);
    process.exit(1);
  }
  
  // Set up keyboard shortcuts (c=copy, r=refresh, q=quit)
  setupKeyboardShortcuts();
  
  // Initial check (will clear screen and show header)
  await pollForIssues();
  
  // Start polling
  setInterval(pollForIssues, POLL_INTERVAL_MS);
}

main().catch(console.error);
