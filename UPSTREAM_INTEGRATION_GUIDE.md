# Upstream Integration Guide

This guide explains how to safely integrate upstream changes from the original OpenCode repository into your `agent_dev` branch while preserving your custom AgentTool and local sharing functionality.

## Overview

Your development setup uses a **three-environment strategy**:
1. **Main Environment** (`/opencode`) - Your active development on `agent_dev` branch
2. **Staging Environment** (`/opencode-staging`) - Safe integration testing 
3. **Backup Environment** (`/opencode-current-state`) - Clean upstream reference

## Prerequisites

### Git Remotes Setup
Ensure you have the following remotes configured:
```bash
git remote -v
# Should show:
# upstream    https://github.com/sst/opencode.git (fetch/push)
# fork        https://github.com/rkunnamp/opencode.git (fetch/push) 
# staging     ../opencode-staging (fetch/push)
```

If missing, add them:
```bash
# Add upstream (original repo)
git remote add upstream https://github.com/sst/opencode.git

# Add your fork
git remote add fork https://github.com/rkunnamp/opencode.git

# Add staging (if not already added)
git remote add staging ../opencode-staging
```

### Worktree Structure
```
/Users/renjithk/Work/test_projects/
├── opencode/                    # Main development environment
├── opencode-staging/            # Staging environment for testing
└── opencode-current-state/      # Clean upstream backup
```

## Step-by-Step Integration Process

### Step 1: Prepare for Integration

1. **Commit your current work**:
   ```bash
   # In main opencode directory
   cd /Users/renjithk/Work/test_projects/opencode
   git add .
   git commit -m "Save work before upstream integration"
   ```

2. **Push to your fork** (backup):
   ```bash
   git push fork agent_dev
   ```

3. **Create integration tag** (for easy rollback):
   ```bash
   git tag "integration-backup-$(date +%Y%m%d-%H%M)"
   ```

### Step 2: Update Staging Environment

1. **Fetch latest upstream changes**:
   ```bash
   git fetch upstream
   git fetch --all
   ```

2. **Reset staging to latest upstream**:
   ```bash
   # Reset staging worktree to latest upstream
   git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging fetch upstream
   git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging reset --hard upstream/dev
   ```

3. **Create fresh staging branch**:
   ```bash
   git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging checkout -B staging-integration-$(date +%Y%m%d)
   ```

### Step 3: Test Integration in Staging

1. **Merge your agent_dev into staging**:
   ```bash
   git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging merge agent_dev
   ```

2. **Resolve conflicts** (if any):
   - **For STATS.md**: Always use upstream version
     ```bash
     git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging checkout --theirs STATS.md
     ```
   
   - **For provider.ts**: Keep both TaskTool and AgentTool, plus upstream imports
     ```bash
     # Edit manually to combine:
     # - Keep upstream imports (like ProviderErrors)  
     # - Keep both TaskTool and AgentTool in TOOLS array
     # - Remove any commented TaskTool lines
     ```
   
   - **For share.ts**: Keep your local version (creates HTML files)
     ```bash
     git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging checkout --ours packages/opencode/src/share/share.ts
     ```

3. **Stage and commit resolved conflicts**:
   ```bash
   git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging add .
   git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging commit -m "Integrate agent_dev with upstream $(date +%Y-%m-%d)"
   ```

### Step 4: Test Staging Environment

1. **Verify AgentTool functionality**:
   ```bash
   # In staging directory, test that both tools are available
   cd ../opencode-staging
   bun run dev  # Start opencode
   # Test: Create an agent subtask
   # Test: Create a task subtask  
   # Test: Share functionality creates HTML files in /tmp/opencode/
   ```

2. **Check for breaking changes**:
   - Test basic functionality
   - Verify your local share creates HTML exports
   - Ensure AgentTool sessions appear in recursive exports
   - Test timeline filtering in HTML exports

### Step 5: Apply to Main Branch

If staging tests pass:

1. **Fetch staging changes to main repo**:
   ```bash
   # In main opencode directory
   cd /Users/renjithk/Work/test_projects/opencode
   git fetch staging
   ```

2. **Merge staging into agent_dev**:
   ```bash
   git merge staging/staging-integration-$(date +%Y%m%d)
   ```

3. **Push updated branch**:
   ```bash
   git push fork agent_dev
   ```

## Troubleshooting

### Common Conflict Scenarios

#### 1. Provider Registration Conflicts
**Problem**: Both upstream and your branch modify `packages/opencode/src/provider/provider.ts`

**Solution**:
```typescript
// In TOOLS array, ensure both are present:
const TOOLS = [
  // ... other tools ...
  TaskTool,      // Your reverted simple version
  AgentTool,     // Your enhanced conversational version  
  TodoReadTool,
]

// Keep upstream imports:
import * as ProviderErrors from "./errors"
```

#### 2. Share Functionality Conflicts  
**Problem**: Upstream changes share.ts to use cloud sharing

**Solution**: Always keep your local version:
```bash
git checkout --ours packages/opencode/src/share/share.ts
```

#### 3. Session Management Conflicts
**Problem**: Upstream modifies session handling that affects your XML metadata

**Solution**: Check that your XML embedding still works:
```typescript
// In agent.ts, ensure this pattern remains:
const embeddedResult = `<result>${taskResult}</result>
<metadata>
sessionID: ${session.id}
title: ${params.description}
modelID: ${modelID}
providerID: ${providerID}
</metadata>`
```

### Rollback Strategy

If integration fails:

1. **Quick rollback**:
   ```bash
   git reset --hard integration-backup-YYYYMMDD-HHMM
   ```

2. **Restore from fork**:
   ```bash
   git reset --hard fork/agent_dev
   ```

3. **Clean staging and retry**:
   ```bash
   git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging reset --hard upstream/dev
   ```

## Automation Script

Save this as `scripts/integrate-upstream.sh`:

```bash
#!/bin/bash
set -e

echo "🔄 Starting upstream integration..."

# Step 1: Backup current work
git add . && git commit -m "WIP: Pre-integration backup" || true
git tag "integration-backup-$(date +%Y%m%d-%H%M)"
git push fork agent_dev

# Step 2: Update staging
echo "📥 Fetching upstream changes..."
git fetch --all

echo "🧪 Preparing staging environment..."
git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging fetch upstream
git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging reset --hard upstream/dev
git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging checkout -B "staging-integration-$(date +%Y%m%d)"

# Step 3: Test merge
echo "🔀 Testing integration in staging..."
if git --git-dir=../opencode-staging/.git --work-tree=../opencode-staging merge agent_dev; then
    echo "✅ Clean merge - no conflicts"
else
    echo "⚠️  Conflicts detected - manual resolution required"
    echo "Run: cd ../opencode-staging && git status"
    exit 1
fi

echo "🎉 Integration staged successfully!"
echo "Next steps:"
echo "1. Test staging environment: cd ../opencode-staging && bun run dev"
echo "2. If tests pass, run: git fetch staging && git merge staging/staging-integration-$(date +%Y%m%d)"
```

## Maintenance Schedule

**Recommended frequency**:
- **Weekly**: Check for upstream updates
- **Bi-weekly**: Integrate non-breaking changes  
- **Monthly**: Full integration with testing

**Before major releases**: Always integrate latest upstream to avoid large conflicts.

## Key Files to Monitor

When reviewing upstream changes, pay special attention to:

- `packages/opencode/src/provider/provider.ts` - Tool registration
- `packages/opencode/src/session/index.ts` - Session management  
- `packages/opencode/src/share/share.ts` - Sharing functionality
- `packages/opencode/src/tool/` - Tool interface changes
- `package.json` - Dependency updates

## Best Practices

1. **Always test in staging first** - Never merge directly to agent_dev
2. **Keep backups** - Tag before each integration
3. **Small, frequent updates** - Easier than large infrequent ones
4. **Document conflicts** - Note resolution patterns for future
5. **Test core functionality** - AgentTool, TaskTool, and local sharing

---

**Questions or Issues?**
If you encounter problems not covered in this guide, document the issue and solution for future reference.