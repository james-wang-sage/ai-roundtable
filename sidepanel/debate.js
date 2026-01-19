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

【来源质量要求 - 区分一手与二手】
⚠️ 审计时会严格区分来源等级，影响最终得分！
✅ 一手来源（高信度）：官方报告、论文、政府数据、公司IR公告、权威机构原文
⚠️ 二手转述（中信度）：权威媒体（Reuters/CNBC）转述，需注明"据XX报道"
❌ 低信度来源（扣分）：博客、论坛、聚合站、社交媒体、AI生成内容
❌ 预测≠事实：投行预测、分析师观点是"预测"，不能当作"已发生的事实"引用

【核心要求 - 思考与整合】
❌ 禁止：简单罗列论据（如"论据1... 论据2... 论据3..."）
✅ 必须：展示你的推理过程，将多个论据有机整合，形成连贯的论证链

请进行立论陈述。要求：
1. 明确阐述你的核心观点
2. 提供至少 3 个论据，优先使用一手来源，每个论据必须有URL
3. 【关键】必须包含"推理/分析"段落，解释这些论据如何相互支持、共同指向你的结论
4. 逻辑清晰，论证有力
5. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效！
⚠️ 仅罗列论据而无思考整合，将严重扣分！
⚠️ 大量使用二手转述/低信度来源，将影响来源可信度评分！`;

  const conPrompt = `你是一场正式辩论的反方辩手。

辩题：${topic}

你的立场：反对该观点（反方）

【重要 - 必须提供来源】
1. 必须使用网络搜索（Web Search）查找最新数据
2. 每个关键论据必须附上来源URL
3. 格式：[论据内容] (来源: URL)

【来源质量要求 - 区分一手与二手】
⚠️ 审计时会严格区分来源等级，影响最终得分！
✅ 一手来源（高信度）：官方报告、论文、政府数据、公司IR公告、权威机构原文
⚠️ 二手转述（中信度）：权威媒体（Reuters/CNBC）转述，需注明"据XX报道"
❌ 低信度来源（扣分）：博客、论坛、聚合站、社交媒体、AI生成内容
❌ 预测≠事实：投行预测、分析师观点是"预测"，不能当作"已发生的事实"引用

【核心要求 - 思考与整合】
❌ 禁止：简单罗列论据（如"论据1... 论据2... 论据3..."）
✅ 必须：展示你的推理过程，将多个论据有机整合，形成连贯的论证链

请进行立论陈述。要求：
1. 明确阐述你的核心观点
2. 提供至少 3 个论据，优先使用一手来源，每个论据必须有URL
3. 【关键】必须包含"推理/分析"段落，解释这些论据如何相互支持、共同指向你的结论
4. 逻辑清晰，论证有力
5. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效！
⚠️ 仅罗列论据而无思考整合，将严重扣分！
⚠️ 大量使用二手转述/低信度来源，将影响来源可信度评分！`;

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

【来源质量审计 - 攻击对方弱点】
审计时会严格区分来源等级！你可以攻击对方的来源质量：
- 对方使用"二手转述"而非一手来源？指出！
- 对方把"预测"当"事实"引用？揭露！
- 对方使用低信度来源（博客/聚合站）？质疑！
同时确保你自己的新论据使用一手来源，避免同样的问题。

【核心要求 - 思考与整合】
❌ 禁止：逐条反驳后简单堆砌（如"反驳1... 反驳2..."）
✅ 必须：展示批判性思维，分析对方论证的结构性缺陷，整合你的反驳形成系统性攻击

本轮重点：${roundFocus[roundNum]}

请进行驳论：
1. 验证并质疑对方引用的来源（一手/二手/预测/事实？）
2. 用有URL来源的一手数据反驳对方
3. 【关键】必须包含"分析/推理"段落，解释为什么你的反驳能够系统性地瓦解对方论证
4. 进一步强化你的立场
5. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效！
⚠️ 仅罗列反驳而无深度分析，将严重扣分！
⚠️ 使用低信度来源将影响你的可信度评分！`;

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

【来源质量审计 - 攻击对方弱点】
审计时会严格区分来源等级！你可以攻击对方的来源质量：
- 对方使用"二手转述"而非一手来源？指出！
- 对方把"预测"当"事实"引用？揭露！
- 对方使用低信度来源（博客/聚合站）？质疑！
同时确保你自己的新论据使用一手来源，避免同样的问题。

【核心要求 - 思考与整合】
❌ 禁止：逐条反驳后简单堆砌（如"反驳1... 反驳2..."）
✅ 必须：展示批判性思维，分析对方论证的结构性缺陷，整合你的反驳形成系统性攻击

本轮重点：${roundFocus[roundNum]}

请进行驳论：
1. 验证并质疑对方引用的来源（一手/二手/预测/事实？）
2. 用有URL来源的一手数据反驳对方
3. 【关键】必须包含"分析/推理"段落，解释为什么你的反驳能够系统性地瓦解对方论证
4. 进一步强化你的立场
5. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效！
⚠️ 仅罗列反驳而无深度分析，将严重扣分！
⚠️ 使用低信度来源将影响你的可信度评分！`;
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
  updateDebateStatus('waiting', '正在进行高标准尽职调查 (Due Diligence)...');

  // ALL 3 AIs will judge for consensus
  const allJudges = ['claude', 'chatgpt', 'gemini'];

  // Build full debate transcript
  const transcript = debateState.history.map(h => {
    const posLabel = h.position === 'pro' ? '正方' : '反方';
    const aiLabel = capitalize(h.ai);
    const phaseLabel = DEBATE_PHASE_NAMES[h.phase];
    return `[${posLabel} (${aiLabel}) - ${phaseLabel}]\n${h.content}`;
  }).join('\n\n' + '='.repeat(50) + '\n\n');

  const getVerdictPrompt = (judgeAI) => `你现在的身份是：【首席风险官 (CRO) & 财务审计师】。
你的任务不是选出辩论的胜者，而是为了"投资决策"或"生命安全"进行尽职调查 (Due Diligence)。

❌ 拒绝模棱两可。
❌ 拒绝盲目信任。
✅ 必须核实每一个关键主张。

辩题：${debateState.topic}
正方：${capitalize(debateState.proAI)}
反方：${capitalize(debateState.conAI)}

辩论记录：
${'='.repeat(50)}
${transcript}
${'='.repeat(50)}

请执行以下审计程序：

第一步：【来源核实】(Source Verification)
请对双方引用的关键URL进行网络搜索验证。
- 只有官方/权威来源（如论文、政府报告、知名媒体）才算有效。
- 博客、论坛、社交媒体视为"低信度"。
- 必须列出：[真实] / [虚假] / [断章取义] / [无效链接] 的具体情况。

第二步：【论证质量评估】(Reasoning Quality Assessment) ⭐新增
评估双方的"思考整合"能力：
- 是否仅仅罗列论据，还是展示了深度推理？
- 论据之间是否有逻辑连接，形成连贯的论证链？
- 是否有"分析/推理"段落解释论据如何支持结论？
⚠️ 仅罗列论据而无思考整合的一方，得分上限为70分！

第三步：【致命风险评估】(Critical Risk Assessment)
如果根据本次辩论的结果进行投资或决策，最大的风险是什么？
是否存在双方都忽略的"黑天鹅"因素？

第四步：【最终裁决】
只有在证据确凿（Sources Verified & Strong Logic & Good Reasoning）的情况下才能判定一方胜出。
如果双方证据都薄弱或缺乏深度思考，必须判定为"资料不足/高风险"。

⚠️ 【极重要】请在回复的最后，严格按以下格式输出结果。
- 不要使用Markdown代码块
- 必须包含开头 ===审计结果=== 和结尾 ===============
- 所有字段必须填写，不能省略

===审计结果===
胜方：[正方/反方/平局/资料不足]
正方得分：[0-100] (低于60分为不及格，仅罗列论据上限70分)
反方得分：[0-100] (低于60分为不及格，仅罗列论据上限70分)
来源可信度-正方：[1-5]星 (1-2星为高风险)
来源可信度-反方：[1-5]星 (1-2星为高风险)
思考整合-正方：[有/无] (无深度推理则标记"无")
思考整合-反方：[有/无] (无深度推理则标记"无")
致命风险：[一句话描述最大风险]
===============

⚠️ 如果缺少结尾的 =============== 将导致审计结果无效！`;

  log(`[审计] 已启动多重风险审查机制 (Claude, ChatGPT, Gemini)...`);

  // Initialize verdict collection
  debateState.verdicts = {};
  debateState.pendingJudges = new Set(allJudges);

  // Send to all judges IN PARALLEL for faster response
  await Promise.all(allJudges.map(judge => sendToAI(judge, getVerdictPrompt(judge))));

  // Clear any existing polling before starting new one
  cleanupVerdictPolling();

  // Collect verdicts with polling
  let attempts = 0;
  const maxAttempts = 90; // 3 minutes max for deep analysis
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
        if (response && response.includes('===审计结果===')) {
          debateState.verdicts[judge] = response;
          debateState.pendingJudges.delete(judge);
          log(`[审计] ${capitalize(judge)} 已提交审计报告`, 'success');
        }
      }
    }

    const receivedCount = totalJudges - debateState.pendingJudges.size;
    updateDebateStatus('waiting',
      `等待审计报告: ${Array.from(debateState.pendingJudges).map(capitalize).join(', ') || '处理中...'} (${receivedCount}/${totalJudges})`);

    // Check if all verdicts collected
    if (debateState.pendingJudges.size === 0) {
      cleanupVerdictPolling();
      processConsensusVerdict();
    }

    // Timeout
    if (attempts >= maxAttempts) {
      cleanupVerdictPolling();
      if (debateState.pendingJudges.size > 0) {
        log(`[审计] 超时，已收到 ${receivedCount}/${totalJudges} 份报告`, 'error');
        if (Object.keys(debateState.verdicts).length >= 2) {
          processConsensusVerdict(); // Process with available verdicts
        } else {
          updateDebateStatus('ready', '审计超时，请重试');
          document.getElementById('request-verdict-btn').disabled = false;
        }
      }
    }
  }, 2000);
}

function processConsensusVerdict() {
  const verdicts = debateState.verdicts;
  const allJudges = Object.keys(verdicts);

  log(`[共识] 正在进行风险加权分析...`);

  // Parse each verdict
  const parsedVerdicts = {};
  const validJudges = [];

  for (const judge of allJudges) {
    parsedVerdicts[judge] = parseVerdictResult(verdicts[judge]);
    if (parsedVerdicts[judge].valid) {
      validJudges.push(judge);
    } else {
      log(`[共识] ⚠️ ${capitalize(judge)} 报告格式无效`, 'error');
    }
  }

  const totalValid = validJudges.length;

  if (totalValid === 0) {
    log('[共识] ❌ 没有有效审计报告', 'error');
    showConsensusVerdict(parsedVerdicts, '无法判定', 'invalid', { '正方': 0, '反方': 0, '平局': 0 }, totalValid);
    return;
  }

  // --- STRICT RELIABILITY CHECK (The "Veto" Logic) ---
  let riskFlag = false;
  let riskReason = '';

  // 1. Check for Low Credibility Sources (<= 2 stars)
  for (const judge of validJudges) {
    const v = parsedVerdicts[judge];
    if (v.proCredibility <= 2 || v.conCredibility <= 2) {
      riskFlag = true;
      riskReason = '来源可信度过低 (存在虚假或低质来源)';
      break;
    }
  }

  // 2. Check for Missing Reasoning Integration (新增：思考整合检查)
  if (!riskFlag) {
    let proNoReasoning = 0, conNoReasoning = 0;
    for (const judge of validJudges) {
      const v = parsedVerdicts[judge];
      if (v.proReasoning === '无') proNoReasoning++;
      if (v.conReasoning === '无') conNoReasoning++;
    }
    // If majority of judges say both sides lack reasoning, flag it
    if (proNoReasoning >= Math.ceil(totalValid / 2) && conNoReasoning >= Math.ceil(totalValid / 2)) {
      riskFlag = true;
      riskReason = '双方均缺乏思考整合 (仅罗列论据，无深度推理)';
    }
  }

  // 3. Check for Low Scores (< 60 is failing, < 75 is weak)
  const avgProScore = validJudges.reduce((s, j) => s + parsedVerdicts[j].proScore, 0) / totalValid;
  const avgConScore = validJudges.reduce((s, j) => s + parsedVerdicts[j].conScore, 0) / totalValid;

  if (!riskFlag && avgProScore < 70 && avgConScore < 70) {
    riskFlag = true;
    riskReason = '双方论证质量均未达到决策标准 (<70分)';
  }

  // --- DETERMINE WINNER ---
  const winnerVotes = { '正方': 0, '反方': 0, '平局': 0, '资料不足': 0 };
  for (const judge of validJudges) {
    const winner = parsedVerdicts[judge].winner;
    if (winnerVotes.hasOwnProperty(winner)) {
      winnerVotes[winner]++;
    } else {
      winnerVotes['资料不足'] = (winnerVotes['资料不足'] || 0) + 1;
    }
  }

  let consensusWinner = '资料不足';
  let consensusLevel = 'disputed';

  if (riskFlag) {
    consensusWinner = '高风险/资料不足';
    consensusLevel = 'risk_flagged';
  } else {
    // Normal consensus logic, but strict
    if (winnerVotes['正方'] >= 2 && avgProScore > 75) {
      consensusWinner = '正方';
      consensusLevel = winnerVotes['正方'] === totalValid ? 'unanimous' : 'majority';
    } else if (winnerVotes['反方'] >= 2 && avgConScore > 75) {
      consensusWinner = '反方';
      consensusLevel = winnerVotes['反方'] === totalValid ? 'unanimous' : 'majority';
    } else {
      consensusWinner = '平局/需进一步研究';
      consensusLevel = 'disputed';
    }
  }

  showConsensusVerdict(parsedVerdicts, consensusWinner, consensusLevel, winnerVotes, totalValid, riskReason);
}

function parseVerdictResult(verdict) {
  const result = {
    valid: false,
    winner: '平局',
    proScore: 0,
    conScore: 0,
    proCredibility: 0,
    conCredibility: 0,
    proReasoning: '无',  // 新增：思考整合评估
    conReasoning: '无',  // 新增：思考整合评估
    criticalRisk: '无',
    rawText: verdict,
    parseErrors: []
  };

  // 尝试匹配完整格式（带结束标记）
  let blockMatch = verdict.match(/={3,}审计结果={3,}([\s\S]*?)={10,}/);

  // 如果没有结束标记，尝试宽松匹配（从 ===审计结果=== 到文末）
  if (!blockMatch) {
    blockMatch = verdict.match(/={3,}审计结果={3,}([\s\S]*?)$/);
  }

  if (!blockMatch) {
    result.parseErrors.push('Missing audit block');
    return result;
  }

  const block = blockMatch[1];

  // Extract fields - 容忍 Markdown 格式 (**字段**:, - 字段:, * 字段: 等)
  // 每个正则支持: 字段:, **字段**:, - 字段:, * **字段**: 等变体

  // 胜方
  const winnerMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?胜方(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(.+?)(?:\*{1,2})?$/m);
  if (winnerMatch) result.winner = winnerMatch[1].trim().replace(/\*+/g, '');

  // 只要有胜方字段，就认为有效
  const hasMinimumFields = winnerMatch !== null;

  // 正方得分 - 提取数字，忽略格式
  const proScoreMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?正方得分(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(\d+)/);
  if (proScoreMatch) result.proScore = parseInt(proScoreMatch[1]);

  // 反方得分
  const conScoreMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?反方得分(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(\d+)/);
  if (conScoreMatch) result.conScore = parseInt(conScoreMatch[1]);

  // 来源可信度-正方 - 提取星级数字
  const proCredMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?来源可信度.?正方(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(\d)/);
  if (proCredMatch) result.proCredibility = parseInt(proCredMatch[1]);

  // 来源可信度-反方
  const conCredMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?来源可信度.?反方(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(\d)/);
  if (conCredMatch) result.conCredibility = parseInt(conCredMatch[1]);

  // 思考整合-正方
  const proReasoningMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?思考整合.?正方(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(有|无)/);
  if (proReasoningMatch) result.proReasoning = proReasoningMatch[1].trim();

  // 思考整合-反方
  const conReasoningMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?思考整合.?反方(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(有|无)/);
  if (conReasoningMatch) result.conReasoning = conReasoningMatch[1].trim();

  // 致命风险
  const riskMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?致命风险(?:\*{1,2})?[：:]\s*(?:\*{1,2})?(.+?)(?:\*{1,2})?$/m);
  if (riskMatch) result.criticalRisk = riskMatch[1].trim().replace(/\*+/g, '');

  // 只要有胜方字段，就认为报告有效（宽松模式）
  // 这样即使部分字段被截断，也能提取可用信息
  result.valid = hasMinimumFields;

  return result;
}

function showConsensusVerdict(parsedVerdicts, consensusWinner, consensusLevel, votes, totalValid, riskReason = '') {
  document.getElementById('debate-active').classList.add('hidden');
  document.getElementById('debate-verdict').classList.remove('hidden');

  const judges = Object.keys(parsedVerdicts);
  const validJudges = judges.filter(j => parsedVerdicts[j].valid);

  // Averages
  let avgProScore = 0, avgConScore = 0;
  if (validJudges.length > 0) {
    avgProScore = Math.round(validJudges.reduce((s, j) => s + parsedVerdicts[j].proScore, 0) / validJudges.length);
    avgConScore = Math.round(validJudges.reduce((s, j) => s + parsedVerdicts[j].conScore, 0) / validJudges.length);
  }

  // Style classes
  let winnerClass = 'tie';
  if (consensusWinner === '正方') winnerClass = 'pro';
  else if (consensusWinner === '反方') winnerClass = 'con';
  else if (consensusWinner.includes('风险') || consensusWinner.includes('资料不足')) winnerClass = 'risk';

  const consensusLabels = {
    unanimous: '🏆 权威认证 (全票通过)',
    majority: '✅ 多数通过',
    risk_flagged: '⛔️ 风险警报 (自动熔断)',
    disputed: '⚠️ 存在争议',
    invalid: '❌ 无效审计'
  };

  let headerHtml = `
    <div class="consensus-badge ${consensusLevel}">${consensusLabels[consensusLevel] || '未知状态'}</div>
    <div class="verdict-winner ${winnerClass}">${consensusWinner}</div>
  `;

  if (riskReason) {
    headerHtml += `<div class="risk-alert">⚠️ 熔断原因: ${riskReason}</div>`;
  }

  // Judge Cards
  let judgeBreakdown = '<div class="judge-breakdown"><h4>独立的审计意见：</h4>';
  for (const judge of judges) {
    const v = parsedVerdicts[judge];
    if (v.valid) {
      const isLowCred = v.proCredibility <= 2 || v.conCredibility <= 2;
      const hasReasoningIssue = v.proReasoning === '无' || v.conReasoning === '无';
      judgeBreakdown += `
        <div class="judge-verdict ${isLowCred || hasReasoningIssue ? 'risk-highlight' : ''}">
          <div class="judge-header">
            <span class="judge-name">${capitalize(judge)}</span>
            <span class="judge-decision">${v.winner}</span>
          </div>
          <div class="judge-metrics">
            <span>得分: ${v.proScore} vs ${v.conScore}</span>
            <span class="${isLowCred ? 'text-danger' : ''}">信度: ⭐${v.proCredibility} vs ⭐${v.conCredibility}</span>
          </div>
          <div class="judge-metrics">
            <span class="${v.proReasoning === '无' ? 'text-danger' : 'text-success'}">思考整合-正: ${v.proReasoning === '有' ? '✓' : '✗'}</span>
            <span class="${v.conReasoning === '无' ? 'text-danger' : 'text-success'}">思考整合-反: ${v.conReasoning === '有' ? '✓' : '✗'}</span>
          </div>
          <div class="judge-risk">风险提示: ${v.criticalRisk}</div>
        </div>`;
    }
  }
  judgeBreakdown += '</div>';

  let html = `
    ${headerHtml}
    <div class="verdict-scores">
      <span class="score pro">正方均分: ${avgProScore}</span>
      <span class="score con">反方均分: ${avgConScore}</span>
    </div>
    ${judgeBreakdown}
    <details class="verdict-details">
      <summary>查看详细审计报告</summary>
      ${judges.map(j => `
        <div class="full-verdict">
          <h5>${capitalize(j)} 的完整报告</h5>
          <div class="verdict-text">${escapeHtml(parsedVerdicts[j].rawText.replace(/===审计结果===[\s\S]*?===============/, '').trim())}</div>
        </div>
      `).join('<hr>')}
    </details>
  `;

  document.getElementById('verdict-content').innerHTML = html;
  debateState.active = false;
  log(`[审计完成] 结果: ${consensusWinner}`, consensusLevel === 'risk_flagged' ? 'error' : 'success');
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
