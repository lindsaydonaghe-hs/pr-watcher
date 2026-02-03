#!/usr/bin/env node

/**
 * Buildkite API integration for PR Watcher
 * 
 * Fetches build details and failure logs from Buildkite.
 * 
 * Usage:
 *   node buildkite.js <buildkite-url>
 *   node buildkite.js https://buildkite.com/handshake/handshake/builds/494087
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '.env') });

const BUILDKITE_TOKEN = process.env.BUILDKITE_TOKEN;
const BUILDKITE_API = 'https://api.buildkite.com/v2';

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

/**
 * Parse Buildkite URL to extract org, pipeline, and build number
 */
export function parseBuildkiteUrl(url) {
  // https://buildkite.com/handshake/handshake/builds/494087
  const match = url.match(/buildkite\.com\/([^/]+)\/([^/]+)\/builds\/(\d+)/);
  if (match) {
    return {
      org: match[1],
      pipeline: match[2],
      buildNumber: match[3],
    };
  }
  return null;
}

/**
 * Fetch build details from Buildkite API
 */
export async function getBuildDetails(org, pipeline, buildNumber) {
  if (!BUILDKITE_TOKEN) {
    return { error: 'BUILDKITE_TOKEN not set in .env file' };
  }

  try {
    const response = await fetch(
      `${BUILDKITE_API}/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}`,
      {
        headers: {
          'Authorization': `Bearer ${BUILDKITE_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { error: 'Invalid Buildkite token' };
      }
      if (response.status === 404) {
        return { error: 'Build not found' };
      }
      return { error: `Buildkite API error: ${response.status}` };
    }

    const build = await response.json();
    return { build };
  } catch (e) {
    return { error: `Failed to fetch: ${e.message}` };
  }
}

/**
 * Get failing jobs from a build
 */
export function getFailingJobs(build) {
  const jobs = build.jobs || [];
  return jobs.filter(job => 
    job.state === 'failed' || 
    job.state === 'timed_out' ||
    job.state === 'canceled'
  );
}

/**
 * Fetch job log from Buildkite
 */
export async function getJobLog(org, pipeline, buildNumber, jobId) {
  if (!BUILDKITE_TOKEN) {
    return { error: 'BUILDKITE_TOKEN not set' };
  }

  try {
    const response = await fetch(
      `${BUILDKITE_API}/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}/jobs/${jobId}/log`,
      {
        headers: {
          'Authorization': `Bearer ${BUILDKITE_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      return { error: `Failed to fetch log: ${response.status}` };
    }

    const data = await response.json();
    return { log: data.content || '' };
  } catch (e) {
    return { error: `Failed to fetch log: ${e.message}` };
  }
}

/**
 * Extract error summary from log content
 */
export function extractErrorSummary(logContent, maxLines = 50) {
  if (!logContent) return null;

  // Remove ANSI escape codes
  const cleanLog = logContent.replace(/\x1b\[[0-9;]*m/g, '');
  
  const lines = cleanLog.split('\n');
  const errors = [];
  
  // Look for common error patterns
  const errorPatterns = [
    /error\s*:/i,
    /Error:/,
    /FAILED/i,
    /TypeError/,
    /SyntaxError/,
    /ReferenceError/,
    /Cannot find/,
    /is not assignable/,
    /TS\d{4,}:/,  // TypeScript errors
    /error TS\d+/i,
    /ENOENT/,
    /AssertionError/,
    /Expected.*but/,
    /✖|✗|❌/,
  ];
  
  let inErrorBlock = false;
  let errorBlockLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this line matches an error pattern
    const isErrorLine = errorPatterns.some(pattern => pattern.test(line));
    
    if (isErrorLine) {
      inErrorBlock = true;
      errorBlockLines = [];
    }
    
    if (inErrorBlock) {
      errorBlockLines.push(line);
      
      // End error block after some context or blank line
      if (errorBlockLines.length >= 10 || (line.trim() === '' && errorBlockLines.length > 3)) {
        errors.push(errorBlockLines.join('\n'));
        inErrorBlock = false;
        
        if (errors.length >= 5) break; // Limit number of error blocks
      }
    }
  }
  
  // If we didn't find specific errors, get the last N lines
  if (errors.length === 0) {
    const lastLines = lines.slice(-maxLines).join('\n');
    return `[Last ${maxLines} lines of output]\n${lastLines}`;
  }
  
  return errors.join('\n\n---\n\n');
}

/**
 * Format build details for display
 */
export function formatBuildDetails(build, failingJobs, jobLogs = {}) {
  const output = [];
  
  output.push(`${COLORS.bright}Buildkite Build #${build.number}${COLORS.reset}`);
  output.push(`${COLORS.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
  output.push(`${COLORS.blue}State:${COLORS.reset} ${build.state}`);
  output.push(`${COLORS.blue}Branch:${COLORS.reset} ${build.branch}`);
  output.push(`${COLORS.blue}Message:${COLORS.reset} ${build.message?.split('\n')[0] || 'N/A'}`);
  output.push(`${COLORS.blue}URL:${COLORS.reset} ${build.web_url}`);
  output.push('');
  
  if (failingJobs.length === 0) {
    output.push(`${COLORS.green}✅ No failing jobs${COLORS.reset}`);
  } else {
    output.push(`${COLORS.red}❌ ${failingJobs.length} failing job(s):${COLORS.reset}`);
    output.push('');
    
    for (const job of failingJobs) {
      output.push(`${COLORS.yellow}━━━ ${job.name} ━━━${COLORS.reset}`);
      output.push(`${COLORS.blue}State:${COLORS.reset} ${job.state}`);
      output.push(`${COLORS.blue}Step:${COLORS.reset} ${job.step_key || job.label || 'N/A'}`);
      
      if (job.web_url) {
        output.push(`${COLORS.blue}URL:${COLORS.reset} ${job.web_url}`);
      }
      
      // Show log content if we have it
      const logResult = jobLogs[job.id];
      if (logResult?.log) {
        const errorSummary = extractErrorSummary(logResult.log);
        if (errorSummary) {
          output.push('');
          output.push(`${COLORS.red}Error Output:${COLORS.reset}`);
          output.push(errorSummary);
        }
      } else if (logResult?.error) {
        output.push(`${COLORS.yellow}Could not fetch log: ${logResult.error}${COLORS.reset}`);
      }
      
      output.push('');
    }
  }
  
  return output.join('\n');
}

/**
 * Main entry point for CLI usage
 */
async function main() {
  const url = process.argv[2];
  
  if (!url) {
    console.error('Usage: node buildkite.js <buildkite-url>');
    console.error('');
    console.error('Example:');
    console.error('  node buildkite.js https://buildkite.com/handshake/handshake/builds/494087');
    process.exit(1);
  }
  
  if (!BUILDKITE_TOKEN) {
    console.error(`${COLORS.red}Error: BUILDKITE_TOKEN not set${COLORS.reset}`);
    console.error('');
    console.error('Add your Buildkite API token to ~/.cursor/mcp-servers/pr-watcher/.env:');
    console.error('  BUILDKITE_TOKEN=bkua_xxxxxxxxxxxxx');
    console.error('');
    console.error('Get a token from: https://buildkite.com/user/api-access-tokens');
    console.error('Required permission: read_builds');
    process.exit(1);
  }
  
  const parsed = parseBuildkiteUrl(url);
  if (!parsed) {
    console.error('Invalid Buildkite URL');
    process.exit(1);
  }
  
  console.log(`${COLORS.blue}Fetching build details...${COLORS.reset}\n`);
  
  const { build, error } = await getBuildDetails(parsed.org, parsed.pipeline, parsed.buildNumber);
  
  if (error) {
    console.error(`${COLORS.red}Error: ${error}${COLORS.reset}`);
    process.exit(1);
  }
  
  const failingJobs = getFailingJobs(build);
  
  // Fetch logs for failing jobs
  const jobLogs = {};
  for (const job of failingJobs) {
    console.log(`${COLORS.blue}Fetching log for: ${job.name}...${COLORS.reset}`);
    jobLogs[job.id] = await getJobLog(parsed.org, parsed.pipeline, parsed.buildNumber, job.id);
  }
  
  console.log('');
  console.log(formatBuildDetails(build, failingJobs, jobLogs));
}

// Run if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
