#!/usr/bin/env node

// CCO Statusline - Full Mode
// Claude Code Statusline - Compact & Alert-Focused
// 2-column header, dynamic sync alerts, conditional staged row

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
  emojiWidth: 2, // Terminal emoji width (1 or 2, try 1 if alignment is off)
};

// ============================================================================
// ICONS
// ============================================================================
const ICON = {
  // Header emojis only (first 2 rows)
  repo: '🔗',    // U+1F517 - wide (2 cells)
  user: '👤',    // U+1F464 - wide (2 cells)
};

// ============================================================================
// BOX DRAWING
// ============================================================================
const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  ml: '├', mr: '┤', mt: '┬', mb: '┴', mc: '┼',
};

// ============================================================================
// ANSI COLORS
// ============================================================================
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Foreground
  gray: '\x1b[90m',
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  blue: '\x1b[94m',
  magenta: '\x1b[95m',
  cyan: '\x1b[96m',
  white: '\x1b[97m',
  // Bold variants
  redBold: '\x1b[1;91m',
  whiteBold: '\x1b[1;97m',
};

function c(text, ...styles) {
  const styleStr = styles.map(s => C[s] || '').join('');
  return `${styleStr}${text}${C.reset}`;
}

// ============================================================================
// UTILITIES
// ============================================================================
function getVisibleLength(str) {
  // Remove ANSI escape codes
  let s = str.replace(/\x1b\[[0-9;]*m/g, '');
  // Remove zero-width characters
  s = s.replace(/[\u{FE00}-\u{FE0F}\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu, '');

  // Wide characters: Full-width emoji pictographs (typically 2 cells in terminal)
  // Range: U+1F300 to U+1FAFF (Miscellaneous Symbols and Pictographs, Emoticons, etc.)
  const wideEmoji = /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/gu;
  s = s.replace(wideEmoji, '  ');

  // Narrow symbols (1 cell): Specific symbols that need width tracking
  // Note: Box drawing (U+2500-U+257F) already counts as 1, don't replace
  // Misc Technical (U+2300-U+23FF), Misc Symbols (U+2600-U+26FF),
  // Dingbats (U+2700-U+27BF), Arrows (U+2190-U+21FF, U+2B00-U+2BFF)
  // These are already width 1, so we just keep them as-is in the length calculation
  // The key insight: all non-wide characters are already width 1, no replacement needed

  return s.length;
}

function padRight(str, len) {
  const visible = getVisibleLength(str);
  return visible >= len ? str : str + ' '.repeat(len - visible);
}

function padLeft(str, len) {
  const visible = getVisibleLength(str);
  return visible >= len ? str : ' '.repeat(len - visible) + str;
}

function padCenter(str, len) {
  const visible = getVisibleLength(str);
  if (visible >= len) return str;
  const total = len - visible;
  const left = Math.floor(total / 2);
  const right = total - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

function execCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 }).replace(/\n$/, '');
  } catch { return null; }
}

// ============================================================================
// PROJECT SIZE
// ============================================================================
function formatBytes(bytes) {
  // Returns { num, unit } for separate styling
  if (bytes >= 1073741824) return { num: (bytes / 1073741824).toFixed(1), unit: 'GB' };
  if (bytes >= 1048576) return { num: (bytes / 1048576).toFixed(1), unit: 'MB' };
  if (bytes >= 1024) return { num: (bytes / 1024).toFixed(0), unit: 'KB' };
  return { num: bytes.toString(), unit: 'B' };
}

function getProjectSize() {
  const tracked = execCmd('git ls-files');
  const untracked = execCmd('git ls-files --others --exclude-standard');
  if (!tracked && !untracked) return null;

  const files = [];
  if (tracked) files.push(...tracked.split('\n').filter(f => f.trim()));
  if (untracked) files.push(...untracked.split('\n').filter(f => f.trim()));
  if (files.length === 0) return null;

  let totalBytes = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) totalBytes += stat.size;
    } catch {}
  }
  return totalBytes > 0 ? formatBytes(totalBytes) : null;  // Returns { num, unit }
}

// ============================================================================
// CLAUDE CODE VERSION
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
  // Shorten common prefixes
  return name.replace(/^Claude\s+/, '');
}

// ============================================================================
// GIT RELEASE VERSION
// ============================================================================
function getLatestRelease() {
  // Try to get the most recent tag (release version)
  const tag = execCmd('git describe --tags --abbrev=0 2>/dev/null');
  return tag || null;
}

// ============================================================================
// GIT INFO
// ============================================================================
function getGitInfo() {
  const branch = execCmd('git rev-parse --abbrev-ref HEAD');
  if (!branch) return null;

  const statusOutput = execCmd('git status --porcelain') || '';
  let mod = 0, add = 0, del = 0, ren = 0;
  let sMod = 0, sAdd = 0, sDel = 0, sRen = 0;
  let conflict = 0, untracked = 0;

  for (const line of statusOutput.split('\n')) {
    if (!line || line.length < 2) continue;
    const idx = line.charAt(0);
    const wt = line.charAt(1);

    if (idx === 'U' || wt === 'U' || (idx === 'D' && wt === 'D') || (idx === 'A' && wt === 'A')) {
      conflict++; continue;
    }
    if (idx === '?' && wt === '?') { untracked++; continue; }

    // Working tree changes
    if (wt === 'M') mod++;
    if (wt === 'D') del++;

    // Staged changes
    if (idx === 'M') sMod++;
    if (idx === 'A') sAdd++;
    if (idx === 'D') sDel++;
    if (idx === 'R') sRen++;
    if (idx === 'C') sAdd++;
  }

  add = untracked;

  // Line counts
  let unstAdd = 0, unstRem = 0, stAdd = 0, stRem = 0;

  const unstaged = execCmd('git diff --numstat');
  if (unstaged) {
    for (const line of unstaged.split('\n')) {
      const p = line.split(/\s+/);
      if (p.length >= 2) {
        const a = parseInt(p[0], 10), r = parseInt(p[1], 10);
        if (!isNaN(a)) unstAdd += a;
        if (!isNaN(r)) unstRem += r;
      }
    }
  }

  if (untracked > 0 && untracked <= 100) {
    const untrackedLines = execCmd('bash -c "git ls-files --others --exclude-standard | head -100 | xargs cat 2>/dev/null | wc -l"');
    if (untrackedLines) {
      const lines = parseInt(untrackedLines, 10);
      if (!isNaN(lines)) unstAdd += lines;
    }
  }

  const staged = execCmd('git diff --cached --numstat');
  if (staged) {
    for (const line of staged.split('\n')) {
      const p = line.split(/\s+/);
      if (p.length >= 2) {
        const a = parseInt(p[0], 10), r = parseInt(p[1], 10);
        if (!isNaN(a)) stAdd += a;
        if (!isNaN(r)) stRem += r;
      }
    }
  }

  // Unpushed commits
  let unpushed = 0;
  const tracking = execCmd('git rev-parse --abbrev-ref @{u}');
  if (tracking) {
    const cnt = execCmd('git rev-list --count @{u}..HEAD');
    unpushed = parseInt(cnt || '0', 10);
  }

  // Stash count
  const stashList = execCmd('git stash list');
  const stash = stashList ? stashList.split('\n').filter(x => x.trim()).length : 0;

  // Repo name
  const gitRoot = execCmd('git rev-parse --show-toplevel');
  const repoName = gitRoot ? path.basename(gitRoot) : null;

  // Last commit time
  const lastCommitTs = execCmd('git log -1 --format=%ct');
  const lastCommit = lastCommitTs ? parseInt(lastCommitTs, 10) : null;

  // Check if there are any staged changes
  const hasStaged = sMod > 0 || sAdd > 0 || sDel > 0 || sRen > 0 || stAdd > 0 || stRem > 0;

  return {
    branch, repoName,
    mod, add, del, ren,
    sMod, sAdd, sDel, sRen,
    unstAdd, unstRem,
    stAdd, stRem,
    unpushed, conflict, stash,
    lastCommit, hasStaged
  };
}

// ============================================================================
// FORMAT LAST COMMIT TIME
// ============================================================================
function formatLastCommit(timestamp) {
  if (!timestamp) return 'never';
  const nowSec = Math.floor(Date.now() / 1000);
  const diffSec = nowSec - timestamp;
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffSec / 3600);
  const diffDay = Math.floor(diffSec / 86400);

  if (diffDay >= 1) {
    const hours = Math.floor((diffSec % 86400) / 3600);
    return hours > 0 ? `${diffDay}d ${hours}h` : `${diffDay}d`;
  }
  const hours = diffHour;
  const mins = diffMin % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
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
  const projectSize = getProjectSize();
  const latestRelease = getLatestRelease();

  // Repo display with optional release tag
  const repoDisplay = git ? `${git.repoName || projectName}:${git.branch}` : 'Not a git repo';
  const releaseDisplay = latestRelease ? c(latestRelease, 'cyan') : null;

  // ─────────────────────────────────────────────────────────────────────────
  // BUILD CONTENT
  // ─────────────────────────────────────────────────────────────────────────
  const hasAlerts = git && (git.unpushed > 0 || git.conflict > 0 || git.stash > 0);

  // Row 1: Repo (left) + optional release tag (right-aligned)
  const repoLeft = `${ICON.repo} ${c(repoDisplay, 'green')}`;
  const repoRight = releaseDisplay || '';

  // Row 2: Version/Model (left) + User/Size (right) - matches minimal layout
  const versionStr = ccVersion ? c(`v${ccVersion}`, 'yellow') : c('v?', 'gray');
  const leftContent = `${versionStr} ${c('·', 'gray')} ${c(modelDisplay, 'magenta')}`;
  const sizeDisplay = projectSize ? c(`${projectSize.num} ${projectSize.unit}`, 'blue') : c('?', 'gray');
  const rightContent = `${ICON.user} ${c(username, 'cyan')} ${c('·', 'gray')} ${sizeDisplay}`;
  const leftContentMin = leftContent;
  const rightContentMin = rightContent;

  // Row 3: Sync
  let syncContent;
  if (!git) {
    syncContent = `${c('Not a git repository', 'gray')}`;
  } else if (hasAlerts) {
    const alerts = [];
    if (git.unpushed > 0) alerts.push(`${c(git.unpushed + ' pending commit' + (git.unpushed > 1 ? 's' : ''), 'yellow')}`);
    if (git.conflict > 0) alerts.push(`${c(git.conflict + ' conflict' + (git.conflict > 1 ? 's' : ''), 'redBold')}`);
    if (git.stash > 0) alerts.push(`${c(git.stash + ' stash' + (git.stash > 1 ? 'es' : ''), 'blue')}`);
    syncContent = `${alerts.join('  ')}`;
  } else {
    syncContent = `${c('No pending commits', 'green')}`;
  }

  // Row 4+: Unstaged/Staged - calculate max widths for dynamic sizing
  const allAddLines = git ? [git.unstAdd, git.hasStaged ? git.stAdd : 0] : [0];
  const allRemLines = git ? [git.unstRem, git.hasStaged ? git.stRem : 0] : [0];
  const maxAddWidth = Math.max(...allAddLines.map(n => n.toString().length));
  const maxRemWidth = Math.max(...allRemLines.map(n => n.toString().length));

  function buildDataRow(label, addLines, remLines, edit, newFiles, delFiles, renameFiles) {
    const addStr = c('+' + addLines.toString().padStart(maxAddWidth), addLines > 0 ? 'green' : 'gray');
    const remStr = c('-' + remLines.toString().padStart(maxRemWidth), remLines > 0 ? 'red' : 'gray');
    const labelLeft = `${c(label, 'white')}`;
    const labelRight = `${addStr} ${remStr}`;

    const editVal = edit > 0 ? c(edit.toString(), 'yellow') : c('0', 'gray');
    const newVal = newFiles > 0 ? c(newFiles.toString(), 'green') : c('0', 'gray');
    const delVal = delFiles > 0 ? c(delFiles.toString(), 'red') : c('0', 'gray');
    const renameVal = renameFiles > 0 ? c(renameFiles.toString(), 'cyan') : c('0', 'gray');

    return { labelLeft, labelRight, editVal, newVal, delVal, renameVal, edit, newFiles, delFiles, renameFiles };
  }

  const unstaged = git ? buildDataRow('Local', git.unstAdd, git.unstRem, git.mod, git.add, git.del, git.ren) : null;
  const staged = git?.hasStaged ? buildDataRow('Staged', git.stAdd, git.stRem, git.sMod, git.sAdd, git.sDel, git.sRen) : null;
  const noGitRow = !git ? { editVal: c('-', 'gray'), newVal: c('-', 'gray'), delVal: c('-', 'gray'), renameVal: c('-', 'gray') } : null;

  // Column headers - dim if all values are 0, colored otherwise
  const hasEdit = (unstaged?.edit || 0) + (staged?.edit || 0) > 0;
  const hasNew = (unstaged?.newFiles || 0) + (staged?.newFiles || 0) > 0;
  const hasDel = (unstaged?.delFiles || 0) + (staged?.delFiles || 0) > 0;
  const hasRename = (unstaged?.renameFiles || 0) + (staged?.renameFiles || 0) > 0;

  const editHeader = hasEdit ? c('mod', 'yellow') : c('mod', 'gray');
  const newHeader = hasNew ? c('add', 'green') : c('add', 'gray');
  const delHeader = hasDel ? c('rm', 'red') : c('rm', 'gray');
  const renameHeader = hasRename ? c('mv', 'cyan') : c('mv', 'gray');

  // ─────────────────────────────────────────────────────────────────────────
  // CALCULATE WIDTHS (each column = max cell width, no padding - separator handles spacing)
  // ─────────────────────────────────────────────────────────────────────────
  const colPadding = 0;

  // Collect cells per column region
  // LEFT: all rows share same left column (row 1 is full-width, not included)
  // For data rows, calculate min width as labelLeft + 2 spaces + labelRight
  const leftCells = [leftContentMin, syncContent];
  if (unstaged) leftCells.push(unstaged.labelLeft + '  ' + unstaged.labelRight);
  if (staged) leftCells.push(staged.labelLeft + '  ' + staged.labelRight);
  if (noGitRow) leftCells.push(`${c('No git data available', 'gray')}`);

  // RIGHT HEADER: row 2 only (row 1 is full-width)
  const rightHeaderCells = [rightContentMin];

  // NARROW COLUMNS: rows 3+ (4 separate columns, include headers for width calc)
  const col0Cells = [editHeader, unstaged?.editVal, staged?.editVal, noGitRow?.editVal].filter(Boolean);
  const col1Cells = [newHeader, unstaged?.newVal, staged?.newVal, noGitRow?.newVal].filter(Boolean);
  const col2Cells = [delHeader, unstaged?.delVal, staged?.delVal, noGitRow?.delVal].filter(Boolean);
  const col3Cells = [renameHeader, unstaged?.renameVal, staged?.renameVal, noGitRow?.renameVal].filter(Boolean);

  // Calculate base widths
  const leftWidth = Math.max(...leftCells.map(s => getVisibleLength(s)));
  const rightHeaderWidth = Math.max(...rightHeaderCells.map(s => getVisibleLength(s)));

  // Narrow column widths: max content + padding
  const colWidths = [
    Math.max(...col0Cells.map(s => getVisibleLength(s))) + colPadding,
    Math.max(...col1Cells.map(s => getVisibleLength(s))) + colPadding,
    Math.max(...col2Cells.map(s => getVisibleLength(s))) + colPadding,
    Math.max(...col3Cells.map(s => getVisibleLength(s))) + colPadding,
  ];
  const narrowTotal = colWidths.reduce((a, b) => a + b, 0) + 6; // +6: row5 has 1 sep (3) + 3 double-spaces (6) = 9, row2 has 1 sep (3), diff = 6

  // CONSTRAINT: right header area = narrow columns area
  // If right header is wider, distribute extra space:
  // 1. First equalize all columns to the widest one
  // 2. Then distribute remainder round-robin
  if (rightHeaderWidth > narrowTotal) {
    let extra = rightHeaderWidth - narrowTotal;

    // Phase 1: Equalize to max width
    while (extra > 0) {
      const maxWidth = Math.max(...colWidths);
      const minWidth = Math.min(...colWidths);
      if (minWidth === maxWidth) break; // All equal

      const minIndex = colWidths.indexOf(minWidth);
      colWidths[minIndex]++;
      extra--;
    }

    // Phase 2: Round-robin distribution
    let i = 0;
    while (extra > 0) {
      colWidths[i % 4]++;
      extra--;
      i++;
    }
  }

  // Final widths: row2 has 1 sep (3), row5 has 1 sep (3) + 3 double-spaces (6) = 9, diff = 6
  const finalNarrowTotal = colWidths.reduce((a, b) => a + b, 0) + 6;
  const headerLeftWidth = leftWidth;
  const headerRightWidth = Math.max(rightHeaderWidth, finalNarrowTotal);
  const bodyWideWidth = leftWidth;

  // Build row 2 content with proper padding
  const row2Left = leftContent;
  const row2Right = rightContent;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER LINES
  // ─────────────────────────────────────────────────────────────────────────
  const lines = [];

  // Separator: adds space only on sides with content
  const sep = ' ' + c(BOX.v, 'gray') + ' ';

  // Row with 2 columns (centerRight: center the right cell)
  // Uses dot separator instead of vertical line
  const dotSep = ' ' + c('·', 'gray') + ' ';
  function row2(content1, content2, width1, width2, centerRight = false) {
    const pad2 = centerRight ? padCenter : padRight;
    return padRight(content1, width1) + dotSep + pad2(content2, width2);
  }

  // Row with 5 columns (1 wide + 4 narrow, narrow cells right-aligned)
  // Only first separator is vertical line, rest are spaces
  function row5(wideContent, c1, c2, c3, c4, wideWidth) {
    return (
      padRight(wideContent, wideWidth) +
      sep + padLeft(c1, colWidths[0]) +
      '  ' + padLeft(c2, colWidths[1]) +
      '  ' + padLeft(c3, colWidths[2]) +
      '  ' + padLeft(c4, colWidths[3])
    );
  }

  // Empty line that Node will process (zero-width space)
  const emptyLine = '\u200B';

  // Top empty line
  lines.push(emptyLine);

  // Row 1: Repo (left) + Release tag (right-aligned)
  const totalWidth = headerLeftWidth + 3 + headerRightWidth; // +3 for ` · `
  const repoLeftLen = getVisibleLength(repoLeft);
  const repoRightLen = getVisibleLength(repoRight);
  const row1Padding = totalWidth - repoLeftLen - repoRightLen;
  lines.push(repoLeft + ' '.repeat(Math.max(1, row1Padding)) + repoRight);

  // Row 2: Version+Model | User+Size
  lines.push(row2(row2Left, row2Right, headerLeftWidth, headerRightWidth));

  // Middle separator (plain horizontal line)
  lines.push(c(BOX.h.repeat(totalWidth), 'gray'));

  // Row 3: Sync | headers
  lines.push(row5(syncContent, editHeader, newHeader, delHeader, renameHeader, bodyWideWidth));

  // Helper: build data row content with right-aligned +/- values
  function buildLabelContent(row) {
    const leftLen = getVisibleLength(row.labelLeft);
    const rightLen = getVisibleLength(row.labelRight);
    const padding = bodyWideWidth - leftLen - rightLen;
    return row.labelLeft + ' '.repeat(Math.max(1, padding)) + row.labelRight;
  }

  // Row 4: Unstaged (or no-git placeholder)
  if (unstaged) {
    lines.push(row5(buildLabelContent(unstaged), unstaged.editVal, unstaged.newVal, unstaged.delVal, unstaged.renameVal, bodyWideWidth));

    // Row 5: Staged (only if has staged changes)
    if (staged) {
      lines.push(row5(buildLabelContent(staged), staged.editVal, staged.newVal, staged.delVal, staged.renameVal, bodyWideWidth));
    }
  } else if (noGitRow) {
    lines.push(row5(`${c('No git data available', 'gray')}`, noGitRow.editVal, noGitRow.newVal, noGitRow.delVal, noGitRow.renameVal, bodyWideWidth));
  }

  // Bottom empty line
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
