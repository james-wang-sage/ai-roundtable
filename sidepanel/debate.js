// AI Panel - Debate Mode Controller
// Separated from panel.js for better code organization

// ============================================
// Debate Mode State & Constants
// ============================================

const DEBATE_PHASES = ['opening', 'rebuttal1', 'rebuttal2', 'rebuttal3', 'closing'];
const DEBATE_PHASE_NAMES = {
  opening: '立论阶段',
  rebuttal1: '驳论第1轮',
  rebuttal2: '驳论第2轮',
  rebuttal3: '驳论第3轮',
  closing: '总结陈词'
};

let debateState = {
  active: false,
  topic: '',
  proAI: null,      // AI arguing FOR the topic
  conAI: null,      // AI arguing AGAINST the topic
  currentPhase: 0,  // Index into DEBATE_PHASES
  history: [],      // [{phase, ai, position: 'pro'|'con', content}]
  pendingResponses: new Set(),
  // Multi-judge consensus
  verdicts: {},           // {judge: verdictText}
  pendingJudges: new Set()
};

// Track polling interval for cleanup
let verdictPollingInterval = null;

// Cleanup function to stop polling and reset state
function cleanupVerdictPolling() {
  if (verdictPollingInterval !== null) {
    clearInterval(verdictPollingInterval);
    verdictPollingInterval = null;
  }
}

// URL detection for source verification
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

function countUrlsInContent(content) {
  const matches = content.match(URL_REGEX);
  return matches ? matches.length : 0;
}

function checkSourceCompliance(content, aiName, position) {
  const urlCount = countUrlsInContent(content);
  const positionLabel = position === 'pro' ? '正方' : '反方';

  if (urlCount === 0) {
    log(`[来源检查] ⚠️ ${capitalize(aiName)} (${positionLabel}) 未提供任何URL来源！论据可信度将受严重影响`, 'error');
    return { compliant: false, urlCount: 0, warning: '无URL来源' };
  } else if (urlCount < 3) {
    log(`[来源检查] ⚠️ ${capitalize(aiName)} (${positionLabel}) 仅提供 ${urlCount} 个URL（建议至少3个）`, 'error');
    return { compliant: false, urlCount, warning: `仅${urlCount}个来源` };
  } else {
    log(`[来源检查] ✓ ${capitalize(aiName)} (${positionLabel}) 提供了 ${urlCount} 个URL来源`, 'success');
    return { compliant: true, urlCount, warning: null };
  }
}

// ============================================
// Debate Mode Setup
// ============================================

function setupDebateMode() {
  // Mode switcher button
  document.getElementById('mode-debate').addEventListener('click', () => switchMode('debate'));

  // Debate controls
  document.getElementById('start-debate-btn').addEventListener('click', startDebate);
  document.getElementById('next-phase-btn').addEventListener('click', nextDebatePhase);
  document.getElementById('end-debate-btn').addEventListener('click', endDebate);
  document.getElementById('request-verdict-btn').addEventListener('click', requestVerdict);
  document.getElementById('new-debate-btn').addEventListener('click', resetDebate);
  document.getElementById('debate-interject-btn').addEventListener('click', handleDebateInterject);

  // Validate debater selection (prevent same AI for both sides)
  const proSelect = document.getElementById('debater-pro');
  const conSelect = document.getElementById('debater-con');

  proSelect.addEventListener('change', () => validateDebaters());
  conSelect.addEventListener('change', () => validateDebaters());
}

// ============================================
// Debate Validation
// ============================================

function validateDebaters() {
  const proAI = document.getElementById('debater-pro').value;
  const conAI = document.getElementById('debater-con').value;
  const startBtn = document.getElementById('start-debate-btn');

  if (proAI === conAI) {
    startBtn.disabled = true;
    startBtn.textContent = '请选择不同的辩手';
  } else {
    startBtn.disabled = false;
    startBtn.textContent = '开始辩论';
  }
}

// ============================================
// Debate Flow Control
// ============================================

async function startDebate() {
  const topic = document.getElementById('debate-topic').value.trim();
  if (!topic) {
    log('请输入辩题', 'error');
    return;
  }

  const proAI = document.getElementById('debater-pro').value;
  const conAI = document.getElementById('debater-con').value;

  if (proAI === conAI) {
    log('正方和反方不能是同一个 AI', 'error');
    return;
  }

  // Initialize debate state
  debateState = {
    active: true,
    topic: topic,
    proAI: proAI,
    conAI: conAI,
    currentPhase: 0,
    history: [],
    pendingResponses: new Set([proAI, conAI])
  };

  // Update UI
  document.getElementById('debate-setup').classList.add('hidden');
  document.getElementById('debate-active').classList.remove('hidden');
  document.getElementById('phase-badge').textContent = DEBATE_PHASE_NAMES.opening;
  document.getElementById('debaters-badge').textContent =
    `${capitalize(proAI)} vs ${capitalize(conAI)}`;
  document.getElementById('debate-topic-display').textContent = topic;
  document.getElementById('pro-tag').textContent = `正方: ${capitalize(proAI)}`;
  document.getElementById('con-tag').textContent = `反方: ${capitalize(conAI)}`;
  updateDebateStatus('waiting', `等待 ${proAI} 和 ${conAI} 的立论...`);

  // Disable buttons during phase
  document.getElementById('next-phase-btn').disabled = true;
  document.getElementById('request-verdict-btn').disabled = true;

  log(`辩论开始: ${capitalize(proAI)} (正方) vs ${capitalize(conAI)} (反方)`, 'success');

  // Send opening statements request to both AIs
  const proPrompt = `你是一场正式辩论的正方辩手。

辩题：${topic}

你的立场：支持该观点（正方）

【重要 - 必须提供来源】
1. 必须使用网络搜索（Web Search）查找最新数据
2. 每个关键论据必须附上来源URL
3. 格式：[论据内容] (来源: URL)

请进行立论陈述。要求：
1. 明确阐述你的核心观点
2. 提供至少 3 个论据，每个论据必须有URL来源
3. 逻辑清晰，论证有力
4. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效，严重影响评分！`;

  const conPrompt = `你是一场正式辩论的反方辩手。

辩题：${topic}

你的立场：反对该观点（反方）

【重要 - 必须提供来源】
1. 必须使用网络搜索（Web Search）查找最新数据
2. 每个关键论据必须附上来源URL
3. 格式：[论据内容] (来源: URL)

请进行立论陈述。要求：
1. 明确阐述你的核心观点
2. 提供至少 3 个论据，每个论据必须有URL来源
3. 逻辑清晰，论证有力
4. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效，严重影响评分！`;

  await sendToAI(proAI, proPrompt);
  await sendToAI(conAI, conPrompt);
}

// ============================================
// Debate Response Handling
// ============================================

function handleDebateResponse(aiType, content) {
  if (!debateState.active) return;

  // Validate that response comes from expected debater
  if (aiType !== debateState.proAI && aiType !== debateState.conAI) {
    log(`[辩论] ⚠️ 忽略来自 ${capitalize(aiType)} 的意外回复（非辩手）`, 'error');
    return;
  }

  // Validate that we're actually expecting this response
  if (!debateState.pendingResponses.has(aiType)) {
    log(`[辩论] ⚠️ 忽略 ${capitalize(aiType)} 的重复回复`, 'error');
    return;
  }

  const position = aiType === debateState.proAI ? 'pro' : 'con';
  const phaseName = DEBATE_PHASES[debateState.currentPhase];

  // Check source compliance (URL requirement) - only for debate phases, not closing
  if (phaseName !== 'closing') {
    const sourceCheck = checkSourceCompliance(content, aiType, position);
    // Store compliance info with the response
    debateState.history.push({
      phase: phaseName,
      ai: aiType,
      position: position,
      content: content,
      sourceCompliance: sourceCheck
    });
  } else {
    // Closing statements don't require new sources
    debateState.history.push({
      phase: phaseName,
      ai: aiType,
      position: position,
      content: content,
      sourceCompliance: null
    });
  }

  // Remove from pending
  debateState.pendingResponses.delete(aiType);

  log(`辩论: ${capitalize(aiType)} (${position === 'pro' ? '正方' : '反方'}) 已回复`, 'success');

  // Check if all pending responses received
  if (debateState.pendingResponses.size === 0) {
    onDebatePhaseComplete();
  } else {
    const remaining = Array.from(debateState.pendingResponses).join(', ');
    updateDebateStatus('waiting', `等待 ${remaining}...`);
  }
}

function onDebatePhaseComplete() {
  const phaseName = DEBATE_PHASE_NAMES[DEBATE_PHASES[debateState.currentPhase]];
  log(`${phaseName}完成`, 'success');
  updateDebateStatus('ready', `${phaseName}完成，可以进入下一阶段`);

  // Enable buttons
  document.getElementById('next-phase-btn').disabled = false;
  document.getElementById('request-verdict-btn').disabled = false;

  // Update next phase button text
  const nextPhaseIndex = debateState.currentPhase + 1;
  if (nextPhaseIndex < DEBATE_PHASES.length) {
    document.getElementById('next-phase-btn').textContent =
      `进入${DEBATE_PHASE_NAMES[DEBATE_PHASES[nextPhaseIndex]]}`;
  } else {
    document.getElementById('next-phase-btn').disabled = true;
    document.getElementById('next-phase-btn').textContent = '辩论已完成';
  }
}

// ============================================
// Debate Phase Progression
// ============================================

async function nextDebatePhase() {
  debateState.currentPhase++;

  if (debateState.currentPhase >= DEBATE_PHASES.length) {
    log('辩论已完成所有阶段', 'success');
    return;
  }

  const phaseName = DEBATE_PHASES[debateState.currentPhase];
  const phaseDisplayName = DEBATE_PHASE_NAMES[phaseName];

  // Update UI
  document.getElementById('phase-badge').textContent = phaseDisplayName;
  document.getElementById('next-phase-btn').disabled = true;
  document.getElementById('request-verdict-btn').disabled = true;

  // Get previous phase responses
  const prevPhase = DEBATE_PHASES[debateState.currentPhase - 1];
  const proResponse = debateState.history.find(
    h => h.phase === prevPhase && h.position === 'pro'
  )?.content || '';
  const conResponse = debateState.history.find(
    h => h.phase === prevPhase && h.position === 'con'
  )?.content || '';

  // Set pending responses
  debateState.pendingResponses = new Set([debateState.proAI, debateState.conAI]);
  updateDebateStatus('waiting', `${phaseDisplayName}: 等待双方回复...`);

  log(`${phaseDisplayName}开始`);

  // Generate phase-specific prompts
  let proPrompt, conPrompt;

  if (phaseName.startsWith('rebuttal')) {
    const roundNum = phaseName.slice(-1);  // '1', '2', or '3'
    const roundFocus = {
      '1': '集中攻击对方的核心论点和主要论据',
      '2': '深入反驳对方的反驳，补充新的论据和证据',
      '3': '做最后的有力反击，巩固你的立场优势'
    };

    proPrompt = `这是辩论的驳论阶段（第 ${roundNum} 轮，共 3 轮）。

辩题：${debateState.topic}
你的立场：正方（支持）

反方的最新观点：
<反方观点>
${conResponse}
</反方观点>

【重要 - 必须提供来源】
1. 使用网络搜索验证对方论据的真实性
2. 新论据必须附上URL来源
3. 指出对方来源的问题（如有）

本轮重点：${roundFocus[roundNum]}

请进行驳论：
1. 验证并质疑对方引用的来源
2. 用有URL来源的数据反驳对方
3. 进一步强化你的立场
4. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效！`;

    conPrompt = `这是辩论的驳论阶段（第 ${roundNum} 轮，共 3 轮）。

辩题：${debateState.topic}
你的立场：反方（反对）

正方的最新观点：
<正方观点>
${proResponse}
</正方观点>

【重要 - 必须提供来源】
1. 使用网络搜索验证对方论据的真实性
2. 新论据必须附上URL来源
3. 指出对方来源的问题（如有）

本轮重点：${roundFocus[roundNum]}

请进行驳论：
1. 验证并质疑对方引用的来源
2. 用有URL来源的数据反驳对方
3. 进一步强化你的立场
4. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效！`;
  } else if (phaseName === 'closing') {
    // Build full debate history for closing
    const allHistory = debateState.history.map(h => {
      const posLabel = h.position === 'pro' ? '正方' : '反方';
      const phaseLabel = DEBATE_PHASE_NAMES[h.phase];
      return `[${posLabel} - ${phaseLabel}]\n${h.content}`;
    }).join('\n\n---\n\n');

    proPrompt = `这是辩论的总结陈词阶段。

辩题：${debateState.topic}
你的立场：正方（支持）

以下是辩论的完整历史：
${allHistory}

请进行总结陈词：
1. 总结你的核心观点和主要论据
2. 回应对方最有力的反驳
3. 强调你方观点的优势
4. 做出有力的结论性陈述
5. 篇幅控制在 200-400 字`;

    conPrompt = `这是辩论的总结陈词阶段。

辩题：${debateState.topic}
你的立场：反方（反对）

以下是辩论的完整历史：
${allHistory}

请进行总结陈词：
1. 总结你的核心观点和主要论据
2. 回应对方最有力的反驳
3. 强调你方观点的优势
4. 做出有力的结论性陈述
5. 篇幅控制在 200-400 字`;
  }

  await sendToAI(debateState.proAI, proPrompt);
  await sendToAI(debateState.conAI, conPrompt);
}

// ============================================
// Debate Interject (Moderator)
// ============================================

async function handleDebateInterject() {
  const input = document.getElementById('debate-interject-input');
  const message = input.value.trim();

  if (!message) {
    log('请输入要发送的消息', 'error');
    return;
  }

  if (!debateState.active) {
    log('当前没有进行中的辩论', 'error');
    return;
  }

  const btn = document.getElementById('debate-interject-btn');
  btn.disabled = true;

  log(`[主持人] 正在获取双方最新回复...`);

  // Get latest responses from both debaters
  const proResponse = await getLatestResponse(debateState.proAI);
  const conResponse = await getLatestResponse(debateState.conAI);

  // Send to both with context
  const proMsg = `[主持人发言] ${message}

反方最新回复：
<反方观点>
${conResponse || '暂无回复'}
</反方观点>

请根据主持人的指导继续辩论。`;

  const conMsg = `[主持人发言] ${message}

正方最新回复：
<正方观点>
${proResponse || '暂无回复'}
</正方观点>

请根据主持人的指导继续辩论。`;

  await sendToAI(debateState.proAI, proMsg);
  await sendToAI(debateState.conAI, conMsg);

  log(`[主持人] 已发送给双方`, 'success');

  input.value = '';
  btn.disabled = false;
}

// ============================================
// Debate Verdict
// ============================================

async function requestVerdict() {
  document.getElementById('request-verdict-btn').disabled = true;
  updateDebateStatus('waiting', '正在请求多裁判共识裁决...');

  // ALL 3 AIs will judge for consensus
  const allJudges = ['claude', 'chatgpt', 'gemini'];

  // Build full debate transcript
  const transcript = debateState.history.map(h => {
    const posLabel = h.position === 'pro' ? '正方' : '反方';
    const aiLabel = capitalize(h.ai);
    const phaseLabel = DEBATE_PHASE_NAMES[h.phase];
    return `[${posLabel} (${aiLabel}) - ${phaseLabel}]\n${h.content}`;
  }).join('\n\n' + '='.repeat(50) + '\n\n');

  const getVerdictPrompt = (judgeAI) => `你是一场正式辩论的独立裁判（${capitalize(judgeAI)}）。

⚠️ 重要：这是高风险决策场景，你的裁决将与其他 AI 裁判的结果进行共识验证。请务必：
1. 独立、客观地评判
2. 严格验证所有引用来源的真实性
3. 对无来源或虚假来源的论据严厉扣分

辩题：${debateState.topic}

正方辩手：${capitalize(debateState.proAI)}（支持该观点）
反方辩手：${capitalize(debateState.conAI)}（反对该观点）

辩论记录：
${'='.repeat(50)}

${transcript}

${'='.repeat(50)}

【核心评判标准 - 按重要性排序】

1. 来源验证（40%权重）⚠️ 最重要
   - 使用网络搜索验证每个引用的URL是否存在、内容是否准确
   - 无来源论据：该论据无效，扣10分
   - 虚假/错误来源：严重违规，扣20分
   - 来源存在但被曲解：扣10分
   - 来源准确可靠：加分

2. 论据质量（25%权重）
   - 数据是否最新、权威
   - 逻辑推理是否严密

3. 反驳有效性（20%权重）
   - 是否有效回应对方论点
   - 是否成功质疑对方来源

4. 表达清晰度（15%权重）
   - 论点是否明确
   - 结构是否清晰

请先给出详细的来源验证报告，然后给出评判，最后在回复【最末尾】严格按以下格式输出：

===裁决结果===
胜方：[正方/反方/平局]
正方得分：[0-100]
反方得分：[0-100]
来源可信度-正方：[1-5]星
来源可信度-反方：[1-5]星
===============`;

  log(`[多裁判共识] 请求 Claude, ChatGPT, Gemini 同时裁判...`);

  // Initialize verdict collection
  debateState.verdicts = {};
  debateState.pendingJudges = new Set(allJudges);

  // Send to all judges IN PARALLEL for faster response
  await Promise.all(allJudges.map(judge => sendToAI(judge, getVerdictPrompt(judge))));

  // Clear any existing polling before starting new one
  cleanupVerdictPolling();

  // Collect verdicts with polling
  let attempts = 0;
  const maxAttempts = 60; // 2 minutes max
  const totalJudges = allJudges.length;

  verdictPollingInterval = setInterval(async () => {
    // Safety check: stop if debate was reset during polling
    if (!debateState.active && debateState.pendingJudges.size === 0) {
      cleanupVerdictPolling();
      return;
    }

    attempts++;

    for (const judge of allJudges) {
      if (!debateState.verdicts[judge]) {
        const response = await getLatestResponse(judge);
        if (response && response.includes('===裁决结果===')) {
          debateState.verdicts[judge] = response;
          debateState.pendingJudges.delete(judge);
          log(`[共识] ${capitalize(judge)} 已提交裁决`, 'success');
        }
      }
    }

    const receivedCount = totalJudges - debateState.pendingJudges.size;
    updateDebateStatus('waiting',
      `等待裁判: ${Array.from(debateState.pendingJudges).map(capitalize).join(', ') || '处理中...'} (${receivedCount}/${totalJudges})`);

    // Check if all verdicts collected
    if (debateState.pendingJudges.size === 0) {
      cleanupVerdictPolling();
      processConsensusVerdict();
    }

    // Timeout
    if (attempts >= maxAttempts) {
      cleanupVerdictPolling();
      if (debateState.pendingJudges.size > 0) {
        log(`[共识] 超时，已收到 ${receivedCount}/${totalJudges} 份裁决`, 'error');
        if (Object.keys(debateState.verdicts).length >= 2) {
          processConsensusVerdict(); // Process with available verdicts
        } else {
          updateDebateStatus('ready', '裁决超时，请重试');
          document.getElementById('request-verdict-btn').disabled = false;
        }
      }
    }
  }, 2000);
}

function processConsensusVerdict() {
  const verdicts = debateState.verdicts;
  const allJudges = Object.keys(verdicts);

  log(`[共识] 正在分析 ${allJudges.length} 份裁决...`);

  // Parse each verdict
  const parsedVerdicts = {};
  const validJudges = [];
  const invalidJudges = [];

  for (const judge of allJudges) {
    parsedVerdicts[judge] = parseVerdictResult(verdicts[judge]);
    if (parsedVerdicts[judge].valid) {
      validJudges.push(judge);
    } else {
      invalidJudges.push(judge);
      log(`[共识] ⚠️ ${capitalize(judge)} 裁决格式无效，已排除: ${parsedVerdicts[judge].parseErrors.join(', ')}`, 'error');
    }
  }

  const totalValid = validJudges.length;

  // Handle edge case: no valid verdicts
  if (totalValid === 0) {
    log('[共识] ❌ 没有有效裁决', 'error');
    showConsensusVerdict(parsedVerdicts, '无共识', 'invalid', { '正方': 0, '反方': 0, '平局': 0 }, totalValid);
    return;
  }

  // Calculate consensus only from VALID verdicts
  const winnerVotes = { '正方': 0, '反方': 0, '平局': 0 };
  for (const judge of validJudges) {
    const winner = parsedVerdicts[judge].winner;
    if (winnerVotes.hasOwnProperty(winner)) {
      winnerVotes[winner]++;
    }
  }

  // Determine consensus result based on actual valid judge count
  let consensusWinner = null;
  let consensusLevel = 'none';

  // Unanimous: all valid judges agree
  if (winnerVotes['正方'] === totalValid || winnerVotes['反方'] === totalValid || winnerVotes['平局'] === totalValid) {
    consensusWinner = Object.keys(winnerVotes).find(k => winnerVotes[k] === totalValid);
    consensusLevel = 'unanimous';
  }
  // Majority: more than half agree (requires at least 2 valid judges)
  else if (totalValid >= 2) {
    const majorityThreshold = Math.floor(totalValid / 2) + 1;
    if (winnerVotes['正方'] >= majorityThreshold) {
      consensusWinner = '正方';
      consensusLevel = 'majority';
    } else if (winnerVotes['反方'] >= majorityThreshold) {
      consensusWinner = '反方';
      consensusLevel = 'majority';
    } else if (winnerVotes['平局'] >= majorityThreshold) {
      consensusWinner = '平局';
      consensusLevel = 'majority';
    } else {
      consensusWinner = '无共识';
      consensusLevel = 'disputed';
    }
  }
  // Only 1 valid judge - use their verdict but mark as single
  else {
    consensusWinner = Object.keys(winnerVotes).find(k => winnerVotes[k] === 1);
    consensusLevel = 'single';
  }

  showConsensusVerdict(parsedVerdicts, consensusWinner, consensusLevel, winnerVotes, totalValid);
}

function parseVerdictResult(verdict) {
  const result = {
    valid: false,        // Whether the verdict was properly formatted
    winner: '平局',
    proScore: 0,
    conScore: 0,
    proCredibility: 0,
    conCredibility: 0,
    rawText: verdict,
    parseErrors: [],      // Track what went wrong for debugging
    usedFallback: false   // Whether we used fallback parsing
  };

  // Try multiple delimiter patterns (LLMs may format slightly differently)
  const delimiterPatterns = [
    /={3,}裁决结果={3,}([\s\S]*?)={10,}/,         // ===裁决结果===...===============
    /={3,}\s*裁决结果\s*={3,}([\s\S]*?)={10,}/,   // === 裁决结果 ===...===============
    /【裁决结果】([\s\S]*?)(?=【|$)/,              // 【裁决结果】...
    /裁决结果[：:]([\s\S]*?)(?=\n\n|$)/            // 裁决结果：...
  ];

  let block = null;
  for (const pattern of delimiterPatterns) {
    const match = verdict.match(pattern);
    if (match) {
      block = match[1];
      break;
    }
  }

  if (!block) {
    result.parseErrors.push('Missing structured verdict block');
    // Try fallback: search entire text for winner pattern
    result.usedFallback = true;
    block = verdict;
  }

  // Winner patterns (more flexible matching)
  const winnerPatterns = [
    /胜方[：:]\s*(正方|反方|平局)/,
    /(?:获胜方|胜出|胜者)[：:]\s*(正方|反方|平局)/,
    /(正方|反方)\s*(?:获胜|胜出|胜)/,
    /(?:结论|判定)[：:]\s*(正方|反方|平局)/
  ];

  let winnerFound = false;
  for (const pattern of winnerPatterns) {
    const match = block.match(pattern);
    if (match) {
      result.winner = match[1];
      winnerFound = true;
      break;
    }
  }

  if (!winnerFound) {
    result.parseErrors.push('Missing or invalid winner field');
  }

  // Score patterns (flexible matching)
  const proScorePatterns = [
    /正方得分[：:]\s*(\d+)/,
    /正方[：:]\s*(\d+)\s*分/,
    /正方.*?(\d+)\s*分/
  ];

  const conScorePatterns = [
    /反方得分[：:]\s*(\d+)/,
    /反方[：:]\s*(\d+)\s*分/,
    /反方.*?(\d+)\s*分/
  ];

  for (const pattern of proScorePatterns) {
    const match = block.match(pattern);
    if (match) {
      result.proScore = parseInt(match[1]);
      break;
    }
  }
  if (result.proScore === 0 && !result.usedFallback) {
    result.parseErrors.push('Missing pro score');
  }

  for (const pattern of conScorePatterns) {
    const match = block.match(pattern);
    if (match) {
      result.conScore = parseInt(match[1]);
      break;
    }
  }
  if (result.conScore === 0 && !result.usedFallback) {
    result.parseErrors.push('Missing con score');
  }

  // Credibility patterns (flexible matching)
  const proCredPatterns = [
    /来源可信度-正方[：:]\s*(\d)/,
    /正方.*?来源.*?(\d)\s*星/,
    /正方.*?可信度[：:]\s*(\d)/
  ];

  const conCredPatterns = [
    /来源可信度-反方[：:]\s*(\d)/,
    /反方.*?来源.*?(\d)\s*星/,
    /反方.*?可信度[：:]\s*(\d)/
  ];

  for (const pattern of proCredPatterns) {
    const match = block.match(pattern);
    if (match) {
      result.proCredibility = parseInt(match[1]);
      break;
    }
  }

  for (const pattern of conCredPatterns) {
    const match = block.match(pattern);
    if (match) {
      result.conCredibility = parseInt(match[1]);
      break;
    }
  }

  // Valid if we found a winner (with some score data preferred but not required)
  result.valid = winnerFound;

  // Log if fallback was used
  if (result.usedFallback && winnerFound) {
    result.parseErrors.push('Used fallback parsing (no structured block found)');
  }

  return result;
}

function showConsensusVerdict(parsedVerdicts, consensusWinner, consensusLevel, votes, totalValid) {
  document.getElementById('debate-active').classList.add('hidden');
  document.getElementById('debate-verdict').classList.remove('hidden');

  const judges = Object.keys(parsedVerdicts);
  const validJudges = judges.filter(j => parsedVerdicts[j].valid);

  // Calculate averages ONLY from valid verdicts (avoid divide by zero)
  let avgProScore = 0, avgConScore = 0, avgProCred = '0.0', avgConCred = '0.0';
  if (validJudges.length > 0) {
    avgProScore = Math.round(validJudges.reduce((sum, j) => sum + parsedVerdicts[j].proScore, 0) / validJudges.length);
    avgConScore = Math.round(validJudges.reduce((sum, j) => sum + parsedVerdicts[j].conScore, 0) / validJudges.length);
    avgProCred = (validJudges.reduce((sum, j) => sum + parsedVerdicts[j].proCredibility, 0) / validJudges.length).toFixed(1);
    avgConCred = (validJudges.reduce((sum, j) => sum + parsedVerdicts[j].conCredibility, 0) / validJudges.length).toFixed(1);
  }

  // Determine winner class
  let winnerClass = 'tie';
  if (consensusWinner === '正方') winnerClass = 'pro';
  else if (consensusWinner === '反方') winnerClass = 'con';
  else if (consensusWinner === '无共识') winnerClass = 'disputed';

  // Dynamic consensus labels based on actual valid judges
  const totalJudges = judges.length;
  const getConsensusLabel = () => {
    switch (consensusLevel) {
      case 'unanimous':
        return `🏆 全票通过 (${totalValid}/${totalValid})`;
      case 'majority':
        const majorityCount = Math.max(votes['正方'], votes['反方'], votes['平局']);
        return `✅ 多数通过 (${majorityCount}/${totalValid})`;
      case 'single':
        return `⚠️ 仅单一有效裁决 (1/${totalJudges})`;
      case 'invalid':
        return `❌ 无有效裁决 (0/${totalJudges})`;
      case 'disputed':
      default:
        return '⚠️ 有争议 - 需人工审核';
    }
  };

  const winnerText = {
    '正方': `正方 (${capitalize(debateState.proAI)}) 获胜`,
    '反方': `反方 (${capitalize(debateState.conAI)}) 获胜`,
    '平局': '平局',
    '无共识': '无共识 - 需人工判断'
  };

  // Build verdict breakdown by judge (show validity status)
  let judgeBreakdown = '<div class="judge-breakdown"><h4>各裁判独立裁决：</h4>';
  for (const judge of judges) {
    const v = parsedVerdicts[judge];
    if (v.valid) {
      judgeBreakdown += `
        <div class="judge-verdict">
          <span class="judge-name">${capitalize(judge)}</span>
          <span class="judge-decision ${v.winner === '正方' ? 'pro' : v.winner === '反方' ? 'con' : 'tie'}">
            ${v.winner} (${v.proScore} vs ${v.conScore})
          </span>
          <span class="judge-cred">来源: ⭐${v.proCredibility} vs ⭐${v.conCredibility}</span>
        </div>`;
    } else {
      judgeBreakdown += `
        <div class="judge-verdict invalid">
          <span class="judge-name">${capitalize(judge)}</span>
          <span class="judge-decision invalid">❌ 格式无效 - 已排除</span>
          <span class="judge-errors">${v.parseErrors.join(', ')}</span>
        </div>`;
    }
  }
  judgeBreakdown += '</div>';

  // Build vote summary (only from valid verdicts)
  const voteSummary = `<div class="vote-summary">
    有效投票 (${totalValid}/${totalJudges}): 正方 ${votes['正方']}票 | 反方 ${votes['反方']}票 | 平局 ${votes['平局']}票
  </div>`;

  let html = `
    <div class="consensus-badge ${consensusLevel}">${getConsensusLabel()}</div>
    <div class="verdict-winner ${winnerClass}">${winnerText[consensusWinner]}</div>
    ${voteSummary}
    <div class="verdict-scores">
      <span class="score pro">正方: ${avgProScore}分 (来源⭐${avgProCred})</span>
      <span class="score con">反方: ${avgConScore}分 (来源⭐${avgConCred})</span>
    </div>
    ${judgeBreakdown}
    <details class="verdict-details">
      <summary>查看完整裁决详情</summary>
      ${judges.map(j => `
        <div class="full-verdict">
          <h5>${capitalize(j)} 的裁决</h5>
          <div style="white-space: pre-wrap; font-size: 12px;">${escapeHtml(parsedVerdicts[j].rawText.replace(/===裁决结果===[\s\S]*?===============/, '').trim())}</div>
        </div>
      `).join('<hr>')}
    </details>
  `;

  document.getElementById('verdict-content').innerHTML = html;
  debateState.active = false;
  log(`[共识裁决] ${getConsensusLabel()} - ${winnerText[consensusWinner]}`, 'success');
}

// ============================================
// Debate Reset & End
// ============================================

function endDebate() {
  if (confirm('确定结束辩论吗？')) {
    resetDebate();
  }
}

function resetDebate() {
  // Clean up any running polling interval first
  cleanupVerdictPolling();

  debateState = {
    active: false,
    topic: '',
    proAI: null,
    conAI: null,
    currentPhase: 0,
    history: [],
    pendingResponses: new Set(),
    verdicts: {},
    pendingJudges: new Set()
  };

  // Reset UI
  document.getElementById('debate-setup').classList.remove('hidden');
  document.getElementById('debate-active').classList.add('hidden');
  document.getElementById('debate-verdict').classList.add('hidden');
  document.getElementById('debate-topic').value = '';
  document.getElementById('next-phase-btn').disabled = true;
  document.getElementById('next-phase-btn').textContent = '下一阶段';
  document.getElementById('request-verdict-btn').disabled = true;

  log('辩论已结束');
}

// ============================================
// Debate Status Updates
// ============================================

function updateDebateStatus(state, text) {
  const statusEl = document.getElementById('debate-status');
  statusEl.textContent = text;
  statusEl.className = 'debate-status ' + state;
}

// ============================================
// Debate State Accessors (for panel.js)
// ============================================

function isDebateActive() {
  return debateState.active;
}

function isDebatePendingResponse(aiType) {
  return debateState.pendingResponses.has(aiType);
}
