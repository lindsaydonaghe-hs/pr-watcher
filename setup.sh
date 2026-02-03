#!/bin/bash

# PR Watcher MCP Server Setup Script

echo "PR Watcher MCP Server Setup"
echo "============================"
echo ""

# Check for GitHub token
if [ -z "$GITHUB_TOKEN" ]; then
    echo "⚠️  GITHUB_TOKEN not set in environment"
    echo ""
    echo "You'll need a GitHub Personal Access Token."
    echo "Create one at: https://github.com/settings/tokens"
    echo "Required scopes: repo (private) or public_repo (public)"
    echo ""
    read -p "Enter your GitHub token (or press Enter to skip): " token
    if [ -n "$token" ]; then
        export GITHUB_TOKEN="$token"
        echo "Token set for this session."
    fi
else
    echo "✓ GITHUB_TOKEN found in environment"
fi

echo ""
echo "MCP Configuration"
echo "-----------------"
echo ""
echo "Add this to your Cursor MCP settings (~/.cursor/mcp.json or Cursor Settings > MCP):"
echo ""
cat << 'EOF'
{
  "mcpServers": {
    "pr-watcher": {
      "command": "node",
      "args": ["$HOME/.cursor/mcp-servers/pr-watcher/index.js"],
      "env": {
        "GITHUB_TOKEN": "<YOUR_TOKEN_HERE>"
      }
    }
  }
}
EOF
echo ""
echo ""
echo "Terminal Watcher Usage"
echo "----------------------"
echo ""
echo "To run the terminal watcher for push notifications:"
echo ""
echo "  GITHUB_TOKEN=xxx node watcher.js owner/repo#123"
echo ""
echo "Example:"
echo "  GITHUB_TOKEN=xxx node watcher.js joinhandshake/joinera#8211"
echo ""
