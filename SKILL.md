# PR Watcher Skill

This skill helps you monitor GitHub PRs for cursorbot issues and CI failures, then fix them interactively.

## When to Use

Use this skill when:
- User asks to "watch my PR" or "monitor PR for issues"
- User mentions cursorbot, codex, buildkite, trunk failures
- User wants to be notified of PR issues
- A terminal shows PR watcher output with new issues
- User pushes a commit and wants to watch for CI results
- User asks to "check the PR" or "check for issues"
- User asks to "fix the issues in the terminal" or "check the watcher"

## Quick Start: Push & Watch

The easiest way is the `gpw` command (git push watch):

```bash
gpw          # Push and auto-detect PR number
gpw 8211     # Push and watch specific PR
```

To enable, add to `~/.zprofile`:
```bash
source ~/.cursor/mcp-servers/pr-watcher/git-push-watch.sh
```

## Automatic Watcher After Push

**IMPORTANT: After pushing code to a PR, automatically start the watcher if not already running.**

After a successful `git push`:
1. Get the PR number (use `gh pr view --json number -q '.number'`)
2. Check if a watcher terminal is already open for this PR
3. If not, start one:
   ```bash
   node ~/.cursor/mcp-servers/pr-watcher/watcher.js <owner>/<repo>#<pr_number>
   ```

Example after push:
```bash
# After git push succeeds:
gh pr view --json number -q '.number'  # Get PR number, e.g., 8211
node ~/.cursor/mcp-servers/pr-watcher/watcher.js joinhandshake/joinera#8211
```

## Setup

The PR Watcher MCP server must be running. If not configured, help the user set it up:

1. Add to Cursor MCP settings (`~/.cursor/mcp.json` or Cursor Settings > MCP):
```json
{
  "mcpServers": {
    "pr-watcher": {
      "command": "node",
      "args": ["/Users/lindsay.donaghe/.cursor/mcp-servers/pr-watcher/index.js"],
      "env": {
        "GITHUB_TOKEN": "<user's GitHub token>"
      }
    }
  }
}
```

2. Or run the terminal watcher for push notifications:
```bash
cd ~/.cursor/mcp-servers/pr-watcher
npm install
GITHUB_TOKEN=xxx node watcher.js joinhandshake/joinera#<PR_NUMBER>
```

3. For Buildkite integration, add to `~/.cursor/mcp-servers/pr-watcher/.env`:
```
GITHUB_TOKEN=ghp_xxx
BUILDKITE_TOKEN=bkua_xxx
```
Get Buildkite token from: https://buildkite.com/user/api-access-tokens (requires `read_builds` permission)

## Workflow

### Starting to Watch a PR

1. User provides a PR URL or reference
2. Call `watch_pr` MCP tool with the PR reference
3. Report initial issues found
4. Explain how to check for updates

### Checking for Issues

1. Call `check_for_issues` MCP tool
2. For each new issue:
   - Display the issue summary clearly
   - Ask user: "Would you like me to fix this?"
   - Wait for user response

### Checking the Watcher Terminal for Issues

### Clipboard Integration

When the watcher detects new issues:
1. A fix prompt is automatically copied to the clipboard
2. A macOS notification appears with "(prompt copied to clipboard)"
3. User can paste directly into Cursor chat to trigger fixes

If the user says "fix the issues" or pastes a prompt starting with "Fix these PR issues:", proceed directly to fixing.

### Checking the Watcher Terminal for Issues

When the user says "check the terminal", "fix the issues", or "check the watcher":

1. **Read the terminal output** - The watcher runs in a terminal. Read the terminal file to see current issues:
   - Terminal files are in the terminals folder (check the workspace info)
   - Look for the terminal running the watcher (shows "PR Watcher" header)

2. **Parse the issues** - The watcher shows issues in this format:
   ```
   📋 3 active issue(s):

     🤖 [CURSOR] [HIGH] review-2739374363
        Duplicate interface definitions with identical str...
        next/clients/next_student/src/components/student-topbar/portal/index.tsx:20

     🧠 [CODEX] [P2] review-123456789
        Use a truthy dev base URL or rosetta-nav keeps...
        next/packages/consumer-external/src/utils/getNavBaseUrls.ts:36

     ❌ [CI] status-43031529865
        buildkite/handshake
        Build #494087 failed (34 minutes, 16 seconds)
        https://buildkite.com/handshake/handshake/builds/494087
   ```

3. **Act on issues:**
   - For **Cursorbot issues** (🤖 [CURSOR]): Read the file at the path shown, understand the issue, and fix it
   - For **Codex issues** (🧠 [CODEX]): Same as cursorbot - read file, understand suggestion, fix it
   - For **CI failures** (❌): Use the Buildkite API to get details (see below)

### Fixing an Issue

When user agrees to fix an issue:

1. Get the issue details (file path, line number, description)
2. Read the relevant file
3. Understand the issue (cursorbot feedback or CI failure)
4. Propose a fix
5. Apply the fix after user confirmation
6. Mark the issue as handled using `mark_issue_handled`
7. Commit the fix (ask user first)

### Getting Issue Details

For detailed info on a cursorbot issue, run:
```bash
node ~/.cursor/mcp-servers/pr-watcher/detail.js <issue-id>
```

Example:
```bash
node ~/.cursor/mcp-servers/pr-watcher/detail.js review-2739374363
```

## Issue Types

### Cursorbot Issues (🤖 [CURSOR])
- Code review feedback with severity (HIGH/MED/LOW)
- May be about code style, patterns, potential bugs
- File path and line number usually provided
- Read the surrounding code context before fixing

### Codex Review Issues (🧠 [CODEX])
- ChatGPT Codex automated review suggestions
- Uses priority levels (P0/P1/P2) instead of severity
- Similar to cursorbot - fix the code at the indicated location
- File path and line number usually provided

### CI Failures (❌ Buildkite/Trunk)
- Could be linting errors, type errors, test failures
- The watcher shows the Buildkite URL

**To investigate CI failures:**

**Option 1: Use Buildkite API (PREFERRED - works with SSO)**

Run the buildkite.js script with the Buildkite URL to fetch failure details:

```bash
node ~/.cursor/mcp-servers/pr-watcher/buildkite.js https://buildkite.com/handshake/handshake/builds/494087
```

This will:
- Fetch build details from Buildkite API
- Show all failing jobs
- Extract and display error messages from logs
- Show file paths and line numbers for TypeScript/lint errors

**Option 2: Run the failing check locally:**
- `yarn check-types` for TypeScript errors
- `yarn lint` for linting issues  
- `yarn test` for test failures
- `yarn nx run <project>:typecheck` for specific project

**Example workflow for CI failures:**
```
1. Watcher shows: "Build #494087 is failing" with URL
2. Run: node ~/.cursor/mcp-servers/pr-watcher/buildkite.js <URL>
3. See the extracted error output showing exactly what file/line has the error
4. Fix the issue
```

## Example Interactions

### Example 1: Watch a PR
```
User: Watch my PR #8211

Agent: [Calls watch_pr for joinhandshake/joinera#8211]
       Now watching PR #8211. Found 2 existing issues:
       - [cursorbot] Hardcoded color in FellowLayoutClient.tsx:39
       - [ci_failure] Trunk Code Quality failed
       
       Would you like me to address any of these?

User: Fix the hardcoded color one

Agent: [Reads file, understands issue, proposes fix]
       I see the issue - there's a hardcoded rgba color that should use
       the design system token. Here's the fix:
       [Shows diff]
       
       Should I apply this fix?

User: Yes

Agent: [Applies fix, marks handled]
       Fixed! Should I commit this change?
```

### Example 2: Push and Auto-Watch
```
User: "push my changes"

Agent:
1. git add . && git commit -m "..." && git push
2. gh pr view --json number -q '.number'  # Get PR 8211
3. node ~/.cursor/mcp-servers/pr-watcher/watcher.js joinhandshake/joinera#8211
4. "I've pushed your changes and started monitoring PR #8211 for issues."
```

### Example 3: Check Watcher and Fix Issues
```
User: "check the watcher and fix any issues"

Agent:
1. Read the terminal file showing the watcher output
2. Parse the active issues
3. For each issue:
   - Cursorbot: Read file, apply fix
   - CI failure: Run buildkite.js, identify error, fix
4. git add . && git commit -m "Fix PR issues" && git push
5. "Fixed X issues and pushed. The watcher will update when checks complete."
```

### Example 4: Investigate CI Failure
```
User: "the buildkite build failed, can you check it?"

Agent:
1. Read watcher terminal to get Buildkite URL
2. node ~/.cursor/mcp-servers/pr-watcher/buildkite.js <url>
3. Parse error output to find failing file/line
4. Fix the issue
5. Push the fix
```

## Terminal Watcher Integration

If the user is running the terminal watcher script, you may see output like:

```
🔔 NEW ISSUE
🤖 CURSORBOT: src/hooks/useNavigationConfig.ts:42
...
>>> Ask Cursor: "Fix issue review-12345"
```

When you see this in terminal output, proactively offer to help:
"I see a new cursorbot issue appeared on your PR. Would you like me to take a look?"

## Terminal Commands Reference

These commands work in user terminals (after sourcing the shell script):

| Command | Description |
|---------|-------------|
| `gp` | Git push + auto-start background watcher |
| `gpw` | Git push + watch in foreground |
| `prwatchfg <PR>` | Watch PR in foreground (shows output) |
| `prwatch <PR>` | Watch PR in background |
| `prstatus` | Show all running watchers |
| `prlog` | Tail background watcher log |
| `prstop` | Stop watcher for current PR |
| `prstop --all` | Stop all watchers |
| `prdetail <ID>` | Get full details for an issue |
| `bklog <URL>` | Get Buildkite failure details |
