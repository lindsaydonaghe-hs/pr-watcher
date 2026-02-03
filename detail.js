#!/usr/bin/env node

/**
 * PR Detail - Show full details for a PR issue
 * 
 * Usage: node detail.js <issue-id> [PR_REF]
 * Or via alias: prdetail <issue-id>
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '.env') });

import { Octokit } from 'octokit';

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

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function getIssueDetail(issueId, prRef) {
  // Parse the issue ID
  const reviewMatch = issueId.match(/^review-(\d+)$/);
  const issueMatch = issueId.match(/^issue-(\d+)$/);
  const ciMatch = issueId.match(/^ci-(\d+)$/);
  
  if (!reviewMatch && !issueMatch && !ciMatch) {
    console.error(`${COLORS.red}Invalid issue ID format.${COLORS.reset}`);
    console.error('Expected: review-<number>, issue-<number>, or ci-<number>');
    process.exit(1);
  }
  
  // Try to get PR info from argument or find from git
  let owner, repo, prNumber;
  
  if (prRef) {
    const match = prRef.match(/([^/]+)\/([^#]+)#(\d+)/);
    if (match) {
      owner = match[1];
      repo = match[2];
      prNumber = parseInt(match[3]);
    }
  }
  
  // If no PR ref, try to detect from git
  if (!owner || !repo) {
    const { execSync } = await import('child_process');
    try {
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
      const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (repoMatch) {
        owner = repoMatch[1];
        repo = repoMatch[2];
      }
      
      // Try to get PR number from gh CLI
      if (!prNumber) {
        try {
          prNumber = parseInt(execSync('gh pr view --json number -q .number', { encoding: 'utf8' }).trim());
        } catch (e) {
          // Ignore
        }
      }
    } catch (e) {
      // Ignore
    }
  }
  
  if (!owner || !repo) {
    console.error(`${COLORS.red}Could not determine repository.${COLORS.reset}`);
    console.error('Run from a git repo or provide PR reference: prdetail <id> owner/repo#123');
    process.exit(1);
  }
  
  console.log(`\n${COLORS.bright}Issue Details: ${issueId}${COLORS.reset}`);
  console.log(`${COLORS.blue}${'━'.repeat(70)}${COLORS.reset}\n`);
  
  if (reviewMatch) {
    const commentId = reviewMatch[1];
    
    try {
      const { data: comment } = await octokit.rest.pulls.getReviewComment({
        owner,
        repo,
        comment_id: commentId,
      });
      
      // Extract severity
      const severityMatch = comment.body?.match(/\*\*(High|Medium|Low)\s+Severity\*\*/i);
      const severity = severityMatch ? severityMatch[1] : 'Unknown';
      const severityColor = severity.toLowerCase() === 'high' ? COLORS.red : 
                           severity.toLowerCase() === 'medium' ? COLORS.yellow : COLORS.blue;
      
      console.log(`${COLORS.cyan}Type:${COLORS.reset} Review Comment`);
      console.log(`${COLORS.cyan}Author:${COLORS.reset} ${comment.user?.login}`);
      console.log(`${COLORS.cyan}Severity:${COLORS.reset} ${severityColor}${severity}${COLORS.reset}`);
      console.log(`${COLORS.cyan}File:${COLORS.reset} ${comment.path}:${comment.line || comment.original_line}`);
      console.log(`${COLORS.cyan}URL:${COLORS.reset} ${comment.html_url}`);
      console.log(`${COLORS.cyan}Created:${COLORS.reset} ${comment.created_at}`);
      console.log(`\n${COLORS.cyan}Content:${COLORS.reset}\n`);
      console.log(comment.body);
      
      // Show diff hunk if available
      if (comment.diff_hunk) {
        console.log(`\n${COLORS.cyan}Code Context:${COLORS.reset}\n`);
        console.log(`${COLORS.blue}${comment.diff_hunk}${COLORS.reset}`);
      }
    } catch (e) {
      console.error(`${COLORS.red}Error fetching comment:${COLORS.reset}`, e.message);
    }
  } else if (issueMatch) {
    const commentId = issueMatch[1];
    
    try {
      const { data: comment } = await octokit.rest.issues.getComment({
        owner,
        repo,
        comment_id: commentId,
      });
      
      console.log(`${COLORS.cyan}Type:${COLORS.reset} Issue Comment`);
      console.log(`${COLORS.cyan}Author:${COLORS.reset} ${comment.user?.login}`);
      console.log(`${COLORS.cyan}URL:${COLORS.reset} ${comment.html_url}`);
      console.log(`${COLORS.cyan}Created:${COLORS.reset} ${comment.created_at}`);
      console.log(`\n${COLORS.cyan}Content:${COLORS.reset}\n`);
      console.log(comment.body);
    } catch (e) {
      console.error(`${COLORS.red}Error fetching comment:${COLORS.reset}`, e.message);
    }
  } else if (ciMatch) {
    const runId = ciMatch[1];
    
    try {
      const { data: run } = await octokit.rest.checks.get({
        owner,
        repo,
        check_run_id: runId,
      });
      
      console.log(`${COLORS.cyan}Type:${COLORS.reset} CI Check`);
      console.log(`${COLORS.cyan}Name:${COLORS.reset} ${run.name}`);
      console.log(`${COLORS.cyan}Status:${COLORS.reset} ${run.status}`);
      console.log(`${COLORS.cyan}Conclusion:${COLORS.reset} ${COLORS.red}${run.conclusion}${COLORS.reset}`);
      console.log(`${COLORS.cyan}URL:${COLORS.reset} ${run.html_url || run.details_url}`);
      
      if (run.output?.summary) {
        console.log(`\n${COLORS.cyan}Summary:${COLORS.reset}\n`);
        console.log(run.output.summary);
      }
      
      if (run.output?.text) {
        console.log(`\n${COLORS.cyan}Details:${COLORS.reset}\n`);
        console.log(run.output.text.slice(0, 2000));
      }
    } catch (e) {
      console.error(`${COLORS.red}Error fetching CI run:${COLORS.reset}`, e.message);
    }
  }
  
  console.log(`\n${COLORS.blue}${'━'.repeat(70)}${COLORS.reset}`);
  console.log(`${COLORS.green}>>> To fix: Ask Cursor "Fix issue ${issueId}"${COLORS.reset}\n`);
}

// Main
const issueId = process.argv[2];
const prRef = process.argv[3];

if (!issueId) {
  console.log('Usage: prdetail <issue-id> [owner/repo#PR]');
  console.log('');
  console.log('Examples:');
  console.log('  prdetail review-12345');
  console.log('  prdetail ci-67890 joinhandshake/handshake#95721');
  process.exit(1);
}

getIssueDetail(issueId, prRef);
