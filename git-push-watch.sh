#!/bin/zsh

# Git Push & Watch - Pushes your commit and starts the PR watcher
# 
# Commands:
#   gpw              # Push and watch (auto-detects PR from branch)
#   gpw 8211         # Push and watch PR #8211
#   gpw --no-verify  # Push with --no-verify and watch
#   gp               # Smart push - starts watcher in background if not running
#   prwatch          # Start watcher for current PR in background
#   prwatchfg        # Start watcher for current PR in foreground (no push)
#   prstatus         # Show status of all watchers
#   prstop           # Stop watcher for current PR (or all with --all)
#   prlog            # Tail the log for current PR watcher
#
# Supports multiple concurrent watchers for different PRs/repos!
#
# Add to your ~/.zprofile:
#   source ~/.cursor/mcp-servers/pr-watcher/git-push-watch.sh

PR_WATCHER_DIR="$HOME/.cursor/mcp-servers/pr-watcher"
PR_WATCHER_RUN_DIR="$PR_WATCHER_DIR/.watchers"

# Ensure run directory exists
mkdir -p "$PR_WATCHER_RUN_DIR" 2>/dev/null

# Sanitize PR ref for use as filename (e.g., "joinhandshake/joinera#123" -> "joinhandshake-joinera-123")
_sanitize_pr_ref() {
    echo "$1" | sed 's/[/#]/-/g'
}

# Get file paths for a specific PR
_get_watcher_files() {
    local pr_ref="$1"
    local safe_name=$(_sanitize_pr_ref "$pr_ref")
    echo "$PR_WATCHER_RUN_DIR/$safe_name"
}

# Check if watcher is running for a specific PR
_pr_watcher_running_for() {
    local pr_ref="$1"
    local base=$(_get_watcher_files "$pr_ref")
    local pid_file="${base}.pid"
    
    if [[ -f "$pid_file" ]]; then
        local pid=$(cat "$pid_file")
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0
        fi
        # Clean up stale files
        rm -f "${base}.pid" "${base}.log" 2>/dev/null
    fi
    return 1
}

# List all running watchers
_list_running_watchers() {
    local found=0
    local pid_files=("$PR_WATCHER_RUN_DIR"/*.pid(N))
    
    for pid_file in "${pid_files[@]}"; do
        [[ -f "$pid_file" ]] || continue
        local pid=$(cat "$pid_file")
        if ps -p "$pid" > /dev/null 2>&1; then
            local base="${pid_file%.pid}"
            local pr_ref=$(cat "${base}.ref" 2>/dev/null || echo "unknown")
            echo "$pr_ref|$pid|${base}.log"
            found=1
        else
            # Clean up stale files
            rm -f "${pid_file}" "${pid_file%.pid}.log" "${pid_file%.pid}.ref" 2>/dev/null
        fi
    done
    return $((1 - found))
}

# Get current PR info
_get_pr_info() {
    local pr_number="$1"
    
    # Get repo info
    local remote_url=$(git remote get-url origin 2>/dev/null)
    if [[ -z "$remote_url" ]]; then
        return 1
    fi
    
    local repo_info=$(echo "$remote_url" | sed -E 's/.*github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/\1\/\2/')
    
    if [[ -z "$repo_info" ]]; then
        return 1
    fi
    
    # Try to get PR number if not provided
    if [[ -z "$pr_number" ]]; then
        if command -v gh &> /dev/null; then
            pr_number=$(gh pr view --json number -q '.number' 2>/dev/null)
        fi
    fi
    
    if [[ -z "$pr_number" ]]; then
        return 1
    fi
    
    echo "${repo_info}#${pr_number}"
}

# Start watcher in background for a specific PR
_start_watcher_bg() {
    local pr_ref="$1"
    local base=$(_get_watcher_files "$pr_ref")
    local pid_file="${base}.pid"
    local log_file="${base}.log"
    local ref_file="${base}.ref"
    
    if _pr_watcher_running_for "$pr_ref"; then
        echo "👀 Watcher already running for $pr_ref"
        echo "   Log: $log_file"
        return 0
    fi
    
    echo "🚀 Starting background watcher for $pr_ref"
    echo "   Log: $log_file"
    
    # Start watcher in background
    (cd "$PR_WATCHER_DIR" && nohup node watcher.js "$pr_ref" > "$log_file" 2>&1 & echo $! > "$pid_file")
    echo "$pr_ref" > "$ref_file"
    
    echo "   Run 'prstatus' to check all watchers, 'prlog' to tail this log"
}

# Smart git push - auto-starts watcher if not running
gp() {
    # Get PR info before push
    local pr_ref=$(_get_pr_info)
    
    # Do the push
    echo "📤 Pushing to origin..."
    git push "$@"
    local push_status=$?
    
    if [[ $push_status -ne 0 ]]; then
        echo "❌ Push failed"
        return $push_status
    fi
    
    # Try to get PR info again (in case PR was just created)
    if [[ -z "$pr_ref" ]]; then
        sleep 1
        pr_ref=$(_get_pr_info)
    fi
    
    if [[ -n "$pr_ref" ]]; then
        echo ""
        _start_watcher_bg "$pr_ref"
    else
        echo ""
        echo "⚠️  No PR found. Create one with: gh pr create"
    fi
    
    return 0
}

# Original gpw - push and watch in foreground
gpw() {
    local pr_number=""
    local push_args=()
    
    # Parse arguments
    for arg in "$@"; do
        if [[ "$arg" =~ ^[0-9]+$ ]]; then
            pr_number="$arg"
        else
            push_args+=("$arg")
        fi
    done
    
    # Get PR info
    local pr_ref=$(_get_pr_info "$pr_number")
    
    if [[ -z "$pr_ref" ]]; then
        echo "⚠️  Could not detect PR. Use: gpw <PR_NUMBER>"
        echo ""
        echo "📤 Pushing anyway..."
        git push "${push_args[@]}"
        return $?
    fi
    
    echo "📤 Pushing to origin..."
    git push "${push_args[@]}"
    local push_status=$?
    
    if [[ $push_status -ne 0 ]]; then
        echo "❌ Push failed"
        return $push_status
    fi
    
    # Stop background watcher for this PR if running
    if _pr_watcher_running_for "$pr_ref"; then
        local base=$(_get_watcher_files "$pr_ref")
        local pid=$(cat "${base}.pid" 2>/dev/null)
        kill "$pid" 2>/dev/null
        rm -f "${base}.pid" "${base}.ref"
        echo "🔄 Stopped background watcher, switching to foreground"
    fi
    
    echo ""
    echo "👀 Starting PR watcher for ${pr_ref}..."
    echo "   Press Ctrl+C to stop watching"
    echo ""
    
    # Start the watcher in foreground
    (cd "$PR_WATCHER_DIR" && node watcher.js "$pr_ref")
}

# Start watcher in background
prwatch() {
    local pr_number="$1"
    local pr_ref=$(_get_pr_info "$pr_number")
    
    if [[ -z "$pr_ref" ]]; then
        if [[ -n "$pr_number" ]]; then
            # Try with just the number
            local repo_info=$(git remote get-url origin 2>/dev/null | sed -E 's/.*github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/\1\/\2/')
            if [[ -n "$repo_info" ]]; then
                pr_ref="${repo_info}#${pr_number}"
            fi
        fi
    fi
    
    if [[ -z "$pr_ref" ]]; then
        echo "⚠️  Could not detect PR. Use: prwatch <PR_NUMBER>"
        return 1
    fi
    
    _start_watcher_bg "$pr_ref"
}

# Start watcher in foreground (no push)
prwatchfg() {
    local pr_number="$1"
    local pr_ref=$(_get_pr_info "$pr_number")
    
    if [[ -z "$pr_ref" ]]; then
        if [[ -n "$pr_number" ]]; then
            local repo_info=$(git remote get-url origin 2>/dev/null | sed -E 's/.*github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/\1\/\2/')
            if [[ -n "$repo_info" ]]; then
                pr_ref="${repo_info}#${pr_number}"
            fi
        fi
    fi
    
    if [[ -z "$pr_ref" ]]; then
        echo "⚠️  Could not detect PR. Use: prwatchfg <PR_NUMBER>"
        return 1
    fi
    
    # Stop background watcher for this PR if running
    if _pr_watcher_running_for "$pr_ref"; then
        local base=$(_get_watcher_files "$pr_ref")
        local pid=$(cat "${base}.pid" 2>/dev/null)
        kill "$pid" 2>/dev/null
        rm -f "${base}.pid" "${base}.ref"
        echo "🔄 Stopped background watcher, switching to foreground"
    fi
    
    echo "👀 Starting PR watcher for ${pr_ref}..."
    echo "   Press Ctrl+C to stop watching"
    echo ""
    
    (cd "$PR_WATCHER_DIR" && node watcher.js "$pr_ref")
}

# Check watcher status for all PRs
prstatus() {
    echo "📊 PR Watcher Status"
    echo ""
    
    local watchers=$(_list_running_watchers)
    
    if [[ -z "$watchers" ]]; then
        echo "No watchers running"
        echo ""
        echo "Start one with:"
        echo "  prwatch <PR_NUMBER>  - background"
        echo "  prwatchfg <PR_NUMBER> - foreground"
        echo "  gp                   - push & auto-start"
        return 1
    fi
    
    echo "Running watchers:"
    echo "$watchers" | while IFS='|' read -r pr_ref pid log_file; do
        echo "  👀 $pr_ref (PID: $pid)"
        echo "     Log: $log_file"
        
        # Show last few lines of issues if any
        if [[ -f "$log_file" ]]; then
            local issues=$(grep -E "^\s*(•|✗)" "$log_file" 2>/dev/null | tail -3)
            if [[ -n "$issues" ]]; then
                echo "     Recent:"
                echo "$issues" | while read -r line; do
                    echo "       $line"
                done
            fi
        fi
        echo ""
    done
}

# Stop watcher(s)
prstop() {
    if [[ "$1" == "--all" ]]; then
        echo "🛑 Stopping all watchers..."
        local pid_files=("$PR_WATCHER_RUN_DIR"/*.pid(N))
        for pid_file in "${pid_files[@]}"; do
            [[ -f "$pid_file" ]] || continue
            local pid=$(cat "$pid_file")
            local base="${pid_file%.pid}"
            local pr_ref=$(cat "${base}.ref" 2>/dev/null || echo "unknown")
            if ps -p "$pid" > /dev/null 2>&1; then
                kill "$pid" 2>/dev/null
                echo "   Stopped: $pr_ref (PID: $pid)"
            fi
            rm -f "${base}.pid" "${base}.log" "${base}.ref"
        done
        return 0
    fi
    
    # Stop watcher for current PR
    local pr_number="$1"
    local pr_ref=$(_get_pr_info "$pr_number")
    
    if [[ -z "$pr_ref" ]]; then
        # Show what's running and ask
        local watchers=$(_list_running_watchers)
        if [[ -z "$watchers" ]]; then
            echo "No watchers running"
            return 0
        fi
        
        echo "Running watchers:"
        echo "$watchers" | while IFS='|' read -r ref pid log; do
            echo "  $ref (PID: $pid)"
        done
        echo ""
        echo "Use: prstop <PR_NUMBER> or prstop --all"
        return 1
    fi
    
    if _pr_watcher_running_for "$pr_ref"; then
        local base=$(_get_watcher_files "$pr_ref")
        local pid=$(cat "${base}.pid")
        kill "$pid" 2>/dev/null
        rm -f "${base}.pid" "${base}.log" "${base}.ref"
        echo "🛑 Stopped watcher for $pr_ref"
    else
        echo "No watcher running for $pr_ref"
    fi
}

# Tail the watcher log for current PR
prlog() {
    local pr_number="$1"
    local pr_ref=$(_get_pr_info "$pr_number")
    
    if [[ -z "$pr_ref" ]]; then
        # If no PR detected, show available logs
        local watchers=$(_list_running_watchers)
        if [[ -z "$watchers" ]]; then
            echo "No watchers running"
            return 1
        fi
        
        # If only one watcher, use that
        local count=$(echo "$watchers" | wc -l | tr -d ' ')
        if [[ "$count" -eq 1 ]]; then
            local log_file=$(echo "$watchers" | cut -d'|' -f3)
            pr_ref=$(echo "$watchers" | cut -d'|' -f1)
            echo "📋 Tailing log for $pr_ref (Ctrl+C to stop)..."
            echo ""
            tail -f "$log_file"
            return
        fi
        
        echo "Multiple watchers running. Specify PR number:"
        echo "$watchers" | while IFS='|' read -r ref pid log; do
            echo "  $ref"
        done
        echo ""
        echo "Use: prlog <PR_NUMBER>"
        return 1
    fi
    
    local base=$(_get_watcher_files "$pr_ref")
    local log_file="${base}.log"
    
    if [[ -f "$log_file" ]]; then
        echo "📋 Tailing log for $pr_ref (Ctrl+C to stop)..."
        echo ""
        tail -f "$log_file"
    else
        echo "No log file for $pr_ref"
        echo "Start watcher with: prwatch"
    fi
}

# Aliases for convenience
alias gpush='gp'
alias pushwatch='gpw'

# Detail viewer
prdetail() {
    (cd "$PR_WATCHER_DIR" && node detail.js "$@")
}

# Buildkite log viewer
bklog() {
    (cd "$PR_WATCHER_DIR" && node buildkite.js "$@")
}

echo "✓ PR Watcher commands: gp, gpw, prwatch, prwatchfg, prstatus, prlog, prstop, prdetail, bklog"
