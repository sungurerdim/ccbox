#!/usr/bin/env node

// CCO Statusline - Full Mode (Optimized)
// Minimal I/O: Uses git status --porcelain=v2 for most data in single call
// Removed: project size (N file stats), line counts (file reads)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ============================================================================
// ANSI COLORS
// ============================================================================
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  blue: '\x1b[94m',
  magenta: '\x1b[95m',
  cyan: '\x1b[96m',
  white: '\x1b[97m',
  redBold: '\x1b[1;91m',
};

function c(text, ...styles) {
  const styleStr = styles.map(s => C[s] || '').join('');
  return `${styleStr}${text}${C.reset}`;
}

// ============================================================================
// UTILITIES
// ============================================================================
function getVisibleLength(str) {
  let s = str.replace(/\x1b\[[0-9;]*m/g, '');
  s = s.replace(/[\u{FE00}-\u{FE0F}\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu, '');
  const wideEmoji = /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/gu;
  s = s.replace(wideEmoji, '  ');
  return s.length;
}

// Justify row parts to target width by distributing spaces evenly around separators
function justifyRow(parts, targetWidth, sepChar) {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];

  const gaps = parts.length - 1;
  const sepWidth = sepChar ? 1 : 0; // · is 1 char
  const contentWidth = parts.reduce((sum, p) => sum + getVisibleLength(p), 0);
  const totalSepWidth = gaps * sepWidth;
  const availableSpace = Math.max(0, targetWidth - contentWidth - totalSepWidth);

  const spacePerGap = Math.floor(availableSpace / gaps);
  const extraSpaces = availableSpace % gaps;

  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const gapSpace = spacePerGap + (i <= extraSpaces ? 1 : 0);
    const leftPad = Math.floor(gapSpace / 2);
    const rightPad = gapSpace - leftPad;
    const sep = sepChar ? c(sepChar, 'gray') : '';
    result += ' '.repeat(leftPad) + sep + ' '.repeat(rightPad) + parts[i];
  }
  return result;
}

function execCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).replace(/\n$/, '');
  } catch { return null; }
}

// ============================================================================
// CLAUDE CODE VERSION (1 process, no disk I/O)
// ============================================================================
function getClaudeCodeVersion() {
  const version = execCmd('claude --version');
  if (version) {
    const match = version.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }
  return null;
}

// ============================================================================
// MODEL NAME
// ============================================================================
function formatModelName(modelData) {
  const name = modelData?.display_name || 'Unknown';
  return name.replace(/^Claude\s+/, '');
}

// ============================================================================
// CONTEXT USAGE
// ============================================================================
function formatContextUsage(contextWindow) {
  if (!contextWindow) return null;
  const contextSize = contextWindow.context_window_size || 0;
  if (contextSize === 0) return null;

  // Use current_usage if available (more accurate), otherwise fallback to total_input_tokens
  // NOTE: Output tokens are NOT counted - they don't consume context window
  const currentUsage = contextWindow.current_usage;
  let currentTokens;

  if (currentUsage) {
    // Accurate: input + cache tokens = actual context usage
    currentTokens = (currentUsage.input_tokens || 0) +
                    (currentUsage.cache_creation_input_tokens || 0) +
                    (currentUsage.cache_read_input_tokens || 0);
  } else {
    // Fallback: only input tokens (not output!)
    currentTokens = contextWindow.total_input_tokens || 0;
  }

  const percent = Math.round(currentTokens * 100 / contextSize);
  const formatK = n => n >= 1000 ? Math.round(n / 1000) + 'K' : n.toString();

  return `${formatK(currentTokens)} ${percent}%`;
}

// ============================================================================
// GIT INFO - OPTIMIZED (2-3 processes instead of 13)
// Uses git status --porcelain=v2 -b --show-stash for most data
// ============================================================================
function getGitInfo() {
  // Single command for: branch, upstream, ahead/behind, stash, all file changes
  // Note: execCmd already uses stdio: 'ignore' for stderr (cross-platform)
  const statusV2 = execCmd('git status --porcelain=v2 -b --show-stash');
  if (!statusV2) return null;

  let branch = null, upstream = null, ahead = 0, behind = 0;
  let mod = 0, add = 0, del = 0, ren = 0;
  let sMod = 0, sAdd = 0, sDel = 0, sRen = 0;
  let conflict = 0;

  for (const line of statusV2.split('\n')) {
    if (!line) continue;

    // Header lines
    if (line.startsWith('# branch.head ')) {
      branch = line.substring(14);
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.substring(18);
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
    }
    // Unmerged entries (conflicts)
    else if (line.startsWith('u ')) {
      conflict++;
    }
    // Changed entries: "1 XY ..."
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.substring(2, 4);
      const idx = xy.charAt(0);  // Staged
      const wt = xy.charAt(1);   // Working tree

      // Working tree (unstaged)
      if (wt === 'M') mod++;
      if (wt === 'D') del++;

      // Index (staged)
      if (idx === 'M') sMod++;
      if (idx === 'A') sAdd++;
      if (idx === 'D') sDel++;
      if (idx === 'R') sRen++;
      if (idx === 'C') sAdd++;
    }
    // Untracked: "? path"
    else if (line.startsWith('? ')) {
      add++;
    }
  }

  if (!branch) return null;

  // Repo name (1 additional call)
  const gitRoot = execCmd('git rev-parse --show-toplevel');
  const repoName = gitRoot ? path.basename(gitRoot) : null;

  // Release tag (1 additional call)
  const releaseTag = execCmd('git describe --tags --abbrev=0') || null;

  const hasStaged = sMod > 0 || sAdd > 0 || sDel > 0 || sRen > 0;

  return {
    branch, repoName, releaseTag,
    mod, add, del, ren,
    sMod, sAdd, sDel, sRen,
    unpushed: ahead, behind, conflict,
    hasStaged
  };
}

// ============================================================================
// BUILD STATUSLINE
// ============================================================================
function formatStatusline(input, git) {
  const username = os.userInfo().username || 'user';
  const fullPath = input.cwd || process.cwd();
  const projectName = path.basename(fullPath);
  const modelDisplay = formatModelName(input.model);
  const ccVersion = getClaudeCodeVersion();
  const contextUsage = formatContextUsage(input.context_window);

  const emptyLine = '\u200B';

  // Prepare row parts (without formatting yet)
  const usernameStr = c(username, 'cyan');
  const versionStr = ccVersion ? c(`CC ${ccVersion}`, 'yellow') : c('CC ?', 'gray');
  const modelStr = c(modelDisplay, 'magenta');
  const contextStr = contextUsage ? c(contextUsage, 'cyan') : null;

  const repoDisplay = git ? `${git.repoName || projectName}:${git.branch}` : projectName;
  const repoStr = c(repoDisplay, 'green');
  const tagStr = git?.releaseTag ? c(git.releaseTag, 'cyan') : null;

  // Alerts
  let alertStr;
  if (!git) {
    alertStr = c('No git', 'gray');
  } else {
    const aheadStr = git.unpushed > 0
      ? c('△ ', 'green') + c(git.unpushed, 'white')
      : c('△ 0', 'gray');
    const behindStr = git.behind > 0
      ? c('▽ ', 'yellow') + c(git.behind, 'white')
      : c('▽ 0', 'gray');
    const alerts = [aheadStr, behindStr];
    if (git.conflict > 0) alerts.push(c(`${git.conflict} conflict${git.conflict > 1 ? 's' : ''}`, 'redBold'));
    alertStr = alerts.join(' ');
  }

  // File changes
  function buildChangesParts(m, a, d, r) {
    return [
      m > 0 ? c(`mod ${m}`, 'yellow') : c('mod 0', 'gray'),
      a > 0 ? c(`add ${a}`, 'green') : c('add 0', 'gray'),
      d > 0 ? c(`del ${d}`, 'red') : c('del 0', 'gray'),
      r > 0 ? c(`mv ${r}`, 'cyan') : c('mv 0', 'gray')
    ];
  }

  const totalMod = git ? git.mod + git.sMod : 0;
  const totalAdd = git ? git.add + git.sAdd : 0;
  const totalDel = git ? git.del + git.sDel : 0;
  const totalRen = git ? git.ren + git.sRen : 0;

  // Define rows as arrays of parts
  // Row 1: Git info (repo:branch, tag) - Location (stable)
  // Row 2: Alerts and file changes - Status (dynamic, easy to scan)
  // Row 3: User info (username, version, model, context) - Session (reference)
  const row1Parts = tagStr ? [repoStr, tagStr] : [repoStr];
  const row2Parts = git ? [alertStr, ...buildChangesParts(totalMod, totalAdd, totalDel, totalRen)] : [alertStr];
  const row3Parts = contextStr ? [usernameStr, versionStr, modelStr, contextStr] : [usernameStr, versionStr, modelStr];

  // Calculate max width from minimum representation (parts joined with single space + separator)
  function minRowWidth(parts) {
    return parts.reduce((sum, p) => sum + getVisibleLength(p), 0) + (parts.length - 1) * 3; // " · " = 3
  }

  const maxWidth = Math.max(minRowWidth(row1Parts), minRowWidth(row2Parts), minRowWidth(row3Parts));

  // Build justified output
  const lines = [];
  lines.push(justifyRow(row1Parts, maxWidth, '·'));
  lines.push(justifyRow(row2Parts, maxWidth, '·'));
  lines.push(justifyRow(row3Parts, maxWidth, '·'));

  lines.push(emptyLine);
  return lines.join('\n');
}

// ============================================================================
// MAIN
// ============================================================================
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const git = getGitInfo();
  console.log(formatStatusline(input, git));
} catch (error) {
  console.log(`[Statusline Error: ${error.message}]`);
}
