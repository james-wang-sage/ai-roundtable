// AI Panel - Debate Mode Controller
// Separated from panel.js for better code organization

// ============================================
// Debate Mode State & Constants
// ============================================

// 标准辩论赛流程：混合模式（并行准备 + 交替发言）
// - 立论阶段：双方并行准备，节省时间
// - 攻辩/驳论/总结：严格交替发言，保证攻防
const DEBATE_PHASES = [
  'opening',          // 【并行】双方同时准备立论
  'attack_pro',       // 正方攻辩（看到双方立论后向反方提问）
  'attack_con',       // 反方攻辩（向正方提问）
  'rebuttal_pro_1',   // 正方驳论第1轮
  'rebuttal_con_1',   // 反方驳论第1轮（针对正方本轮）
  'rebuttal_pro_2',   // 正方驳论第2轮
  'rebuttal_con_2',   // 反方驳论第2轮
  'closing_con',      // 反方总结陈词（先说）
  'closing_pro'       // 正方总结陈词（最后发言权）
];

const DEBATE_PHASE_NAMES = {
  opening: '立论阶段',
  attack_pro: '正方攻辩',
  attack_con: '反方攻辩',
  rebuttal_pro_1: '正方驳论(1)',
  rebuttal_con_1: '反方驳论(1)',
  rebuttal_pro_2: '正方驳论(2)',
  rebuttal_con_2: '反方驳论(2)',
  closing_con: '反方总结',
  closing_pro: '正方总结'
};

// 辅助函数：判断当前阶段是哪方发言
// 返回 'pro' | 'con' | 'both'（并行阶段）
function getPhaseDebater(phaseName) {
  // 并行阶段：双方同时准备
  if (phaseName === 'opening') return 'both';
  // 其他阶段按后缀判断
  if (phaseName.endsWith('_pro')) return 'pro';
  if (phaseName.endsWith('_con')) return 'con';
  // 处理带数字的阶段名 (rebuttal_pro_1 等)
  if (phaseName.includes('_pro_')) return 'pro';
  if (phaseName.includes('_con_')) return 'con';
  return null;
}

let debateState = {
  active: false,
  topic: '',
  proAI: null,      // AI arguing FOR the topic
  conAI: null,      // AI arguing AGAINST the topic
  judgeAI: null,    // AI acting as judge (user-selected)
  currentPhase: 0,  // Index into DEBATE_PHASES
  history: [],      // [{phase, ai, position: 'pro'|'con', content}]
  pendingResponses: new Set(),
  phaseInFlight: false,  // 防止双击导致阶段跳过
  lateResponses: [],     // 存储迟到的回复，避免丢失
  // Judge verdict
  verdict: null
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

  // Validate debater and judge selection (prevent same AI for multiple roles)
  const proSelect = document.getElementById('debater-pro');
  const conSelect = document.getElementById('debater-con');
  const judgeSelect = document.getElementById('debater-judge');

  proSelect.addEventListener('change', () => validateDebaters());
  conSelect.addEventListener('change', () => validateDebaters());
  judgeSelect.addEventListener('change', () => validateDebaters());
}

// ============================================
// Debate Validation
// ============================================

function validateDebaters() {
  const proAI = document.getElementById('debater-pro').value;
  const conAI = document.getElementById('debater-con').value;
  const judgeAI = document.getElementById('debater-judge').value;
  const startBtn = document.getElementById('start-debate-btn');

  // Check for conflicts: all three must be different
  if (proAI === conAI) {
    startBtn.disabled = true;
    startBtn.textContent = '正方反方不能相同';
  } else if (judgeAI === proAI || judgeAI === conAI) {
    startBtn.disabled = true;
    startBtn.textContent = '裁判不能参与辩论';
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
  const judgeAI = document.getElementById('debater-judge').value;

  if (proAI === conAI) {
    log('正方和反方不能是同一个 AI', 'error');
    return;
  }

  if (judgeAI === proAI || judgeAI === conAI) {
    log('裁判不能同时参与辩论', 'error');
    return;
  }

  // Initialize debate state
  debateState = {
    active: true,
    topic: topic,
    proAI: proAI,
    conAI: conAI,
    judgeAI: judgeAI,
    currentPhase: 0,
    history: [],
    pendingResponses: new Set([proAI, conAI]),  // 混合模式：双方并行准备
    phaseInFlight: true,  // 标记阶段进行中
    lateResponses: [],
    verdict: null
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
  document.getElementById('judge-tags').textContent = capitalize(judgeAI);
  updateDebateStatus('waiting', `【立论准备】双方正在并行准备立论...`);

  // Disable buttons during phase
  document.getElementById('next-phase-btn').disabled = true;
  document.getElementById('request-verdict-btn').disabled = true;

  log(`辩论开始: ${capitalize(proAI)} (正方) vs ${capitalize(conAI)} (反方)`, 'success');
  log(`[混合模式] 双方并行准备立论中...`);

  // 混合模式：双方同时准备立论（并行，节省时间）
  const openingPromptBase = `【重要 - 必须提供来源】
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

  const proPrompt = `你是一场正式辩论的正方辩手。

辩题：${topic}

你的立场：支持该观点（正方）

${openingPromptBase}`;

  const conPrompt = `你是一场正式辩论的反方辩手。

辩题：${topic}

你的立场：反对该观点（反方）

${openingPromptBase}`;

  // 真正并行发送给双方（使用 Promise.all 确保同时发送）
  await Promise.all([
    sendToAI(proAI, proPrompt),
    sendToAI(conAI, conPrompt)
  ]);
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

  // 处理迟到的回复（阶段已切换但回复才到）
  if (!debateState.pendingResponses.has(aiType)) {
    const position = aiType === debateState.proAI ? 'pro' : 'con';
    const positionLabel = position === 'pro' ? '正方' : '反方';

    // 存储迟到回复而不是丢弃
    debateState.lateResponses.push({
      phase: DEBATE_PHASES[debateState.currentPhase - 1] || 'unknown',
      ai: aiType,
      position: position,
      content: content,
      timestamp: Date.now()
    });

    log(`[辩论] ⚠️ ${capitalize(aiType)} (${positionLabel}) 的回复迟到，已保存但不影响当前阶段`, 'error');
    return;
  }

  const position = aiType === debateState.proAI ? 'pro' : 'con';
  const phaseName = DEBATE_PHASES[debateState.currentPhase];

  // Check source compliance (URL requirement) - only for non-closing phases
  const isClosingPhase = phaseName.startsWith('closing');
  if (!isClosingPhase) {
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

  const phaseDisplayName = DEBATE_PHASE_NAMES[phaseName];
  const positionLabel = position === 'pro' ? '正方' : '反方';
  log(`[${phaseDisplayName}] ${capitalize(aiType)} (${positionLabel}) 已完成发言`, 'success');

  // Check if all pending responses received
  if (debateState.pendingResponses.size === 0) {
    onDebatePhaseComplete();
  } else {
    // 并行阶段：显示已完成的一方，等待另一方
    const remaining = Array.from(debateState.pendingResponses).map(capitalize).join(', ');
    updateDebateStatus('waiting', `【${phaseDisplayName}】${capitalize(aiType)} 已完成，等待 ${remaining}...`);
  }
}

function onDebatePhaseComplete() {
  const phaseName = DEBATE_PHASE_NAMES[DEBATE_PHASES[debateState.currentPhase]];
  log(`${phaseName}完成`, 'success');

  // 阶段完成，解除锁定
  debateState.phaseInFlight = false;

  // Enable buttons
  document.getElementById('next-phase-btn').disabled = false;
  document.getElementById('request-verdict-btn').disabled = false;

  // Update next phase button text
  const nextPhaseIndex = debateState.currentPhase + 1;
  if (nextPhaseIndex < DEBATE_PHASES.length) {
    const nextPhaseName = DEBATE_PHASE_NAMES[DEBATE_PHASES[nextPhaseIndex]];
    document.getElementById('next-phase-btn').textContent = `进入${nextPhaseName}`;
    updateDebateStatus('ready', `${phaseName}完成 → 点击进入${nextPhaseName}`);
  } else {
    document.getElementById('next-phase-btn').disabled = true;
    document.getElementById('next-phase-btn').textContent = '辩论已完成';
    updateDebateStatus('ready', '所有阶段完成，可以请求裁决');
  }
}

// ============================================
// Debate Phase Progression (混合模式)
// ============================================

async function nextDebatePhase() {
  // 防护检查：辩论未激活
  if (!debateState.active) {
    log('[辩论] 辩论未激活，无法进入下一阶段', 'error');
    return;
  }

  // 防护检查：阶段正在进行中（防止双击）
  if (debateState.phaseInFlight) {
    log('[辩论] 当前阶段正在进行，请等待完成', 'error');
    return;
  }

  // 防护检查：还有未完成的回复
  if (debateState.pendingResponses.size > 0) {
    const remaining = Array.from(debateState.pendingResponses).map(capitalize).join(', ');
    log(`[辩论] 还在等待 ${remaining} 的回复`, 'error');
    return;
  }

  debateState.currentPhase++;

  if (debateState.currentPhase >= DEBATE_PHASES.length) {
    log('辩论已完成所有阶段', 'success');
    return;
  }

  // 标记阶段进行中
  debateState.phaseInFlight = true;

  const phaseName = DEBATE_PHASES[debateState.currentPhase];
  const phaseDisplayName = DEBATE_PHASE_NAMES[phaseName];
  const debaterPosition = getPhaseDebater(phaseName);

  // Update UI - 立即禁用按钮防止双击
  document.getElementById('phase-badge').textContent = phaseDisplayName;
  document.getElementById('next-phase-btn').disabled = true;
  document.getElementById('request-verdict-btn').disabled = true;

  // 根据阶段类型决定发言方
  if (debaterPosition === 'both') {
    // 并行阶段：双方同时发言
    debateState.pendingResponses = new Set([debateState.proAI, debateState.conAI]);
    updateDebateStatus('waiting', `【${phaseDisplayName}】双方并行准备中...`);
    log(`[并行阶段] ${phaseDisplayName}开始`);

    const proPrompt = generatePhasePrompt(phaseName, 'pro');
    const conPrompt = generatePhasePrompt(phaseName, 'con');

    // 真正并行发送（使用 Promise.all）
    await Promise.all([
      sendToAI(debateState.proAI, proPrompt),
      sendToAI(debateState.conAI, conPrompt)
    ]);
  } else {
    // 交替阶段：单方发言
    const currentDebater = debaterPosition === 'pro' ? debateState.proAI : debateState.conAI;
    debateState.pendingResponses = new Set([currentDebater]);
    updateDebateStatus('waiting', `【${phaseDisplayName}】等待 ${capitalize(currentDebater)} 发言...`);
    log(`[交替发言] ${phaseDisplayName}开始，${capitalize(currentDebater)} 发言`);

    const prompt = generatePhasePrompt(phaseName, debaterPosition);
    await sendToAI(currentDebater, prompt);
  }
}

// ============================================
// Phase-specific Prompt Generator
// ============================================

function generatePhasePrompt(phaseName, position) {
  const topic = debateState.topic;
  const positionLabel = position === 'pro' ? '正方（支持）' : '反方（反对）';
  const opposingLabel = position === 'pro' ? '反方' : '正方';

  // 获取对方的最新回复（用于反驳/回应）
  const getOpposingResponse = () => {
    // 查找对方最近的发言
    for (let i = debateState.history.length - 1; i >= 0; i--) {
      const h = debateState.history[i];
      if (h.position !== position) {
        return h.content;
      }
    }
    return '';
  };

  // 获取己方的最新回复
  const getOwnResponse = () => {
    for (let i = debateState.history.length - 1; i >= 0; i--) {
      const h = debateState.history[i];
      if (h.position === position) {
        return h.content;
      }
    }
    return '';
  };

  // ========== 攻辩阶段 (attack_pro / attack_con) ==========
  // 攻辩时双方都能看到彼此的立论，保证公平
  if (phaseName === 'attack_pro' || phaseName === 'attack_con') {
    // 获取双方的立论内容
    const proOpening = debateState.history.find(h => h.phase === 'opening' && h.position === 'pro')?.content || '';
    const conOpening = debateState.history.find(h => h.phase === 'opening' && h.position === 'con')?.content || '';

    // 获取之前的攻辩内容（如果有）
    const previousAttack = getOpposingResponse();
    const hasPreviousAttack = phaseName === 'attack_con' && previousAttack;

    let contextSection = `【双方立论】

<正方立论>
${proOpening}
</正方立论>

<反方立论>
${conOpening}
</反方立论>`;

    if (hasPreviousAttack) {
      contextSection += `

【正方的攻辩】
<正方攻辩>
${previousAttack}
</正方攻辩>`;
    }

    return `这是辩论的【攻辩阶段】。

辩题：${topic}
你的立场：${positionLabel}

${contextSection}

【攻辩规则】
攻辩是辩论赛的核心环节！你需要：
1. 针对对方立论中的论点提出 2-3 个尖锐问题
2. 指出对方论证中的逻辑漏洞或事实错误
3. 用反问或追问揭露对方立场的弱点
${hasPreviousAttack ? '4. 可以回应对方的攻辩问题' : ''}

【问题格式要求】
每个问题应该：
- 直接针对对方立论中的具体论据
- 暴露对方论证的弱点
- 让对方难以回避

【重要 - 必须提供来源】
如果你引用新的事实或数据来质疑对方，必须附上URL来源。

请进行攻辩（向对方提问）：
1. 提出 2-3 个针对性问题
2. 每个问题要指出对方的具体问题所在
3. 可以用反证或事实质疑对方
4. 篇幅控制在 200-400 字

⚠️ 攻辩问题必须有理有据，不能空洞质疑！`;
  }

  // ========== 驳论阶段 (rebuttal_pro_1/2, rebuttal_con_1/2) ==========
  if (phaseName.includes('rebuttal')) {
    const roundNum = phaseName.endsWith('_1') ? '1' : '2';
    const opposingResponse = getOpposingResponse();
    const roundFocus = {
      '1': '集中攻击对方的核心论点，回应对方的攻辩问题',
      '2': '深入反驳，做最后的有力攻击，巩固你的立场优势'
    };

    return `这是辩论的【驳论阶段】（第 ${roundNum} 轮，共 2 轮）。

辩题：${topic}
你的立场：${positionLabel}

【${opposingLabel}的最新发言】
<${opposingLabel}观点>
${opposingResponse}
</${opposingLabel}观点>

【重要 - 必须提供来源】
1. 使用网络搜索验证对方论据的真实性
2. 新论据必须附上URL来源
3. 指出对方来源的问题（如有）

【来源质量审计 - 攻击对方弱点】
审计时会严格区分来源等级！你可以攻击对方的来源质量：
- 对方使用"二手转述"而非一手来源？指出！
- 对方把"预测"当"事实"引用？揭露！
- 对方使用低信度来源（博客/聚合站）？质疑！

【核心要求 - 思考与整合】
❌ 禁止：逐条反驳后简单堆砌
✅ 必须：展示批判性思维，整合你的反驳形成系统性攻击

本轮重点：${roundFocus[roundNum]}

请进行驳论：
1. 回应对方的攻辩问题（如有）
2. 验证并质疑对方引用的来源
3. 用有URL来源的一手数据反驳对方
4. 【关键】必须包含"分析/推理"段落
5. 篇幅控制在 300-500 字

⚠️ 无来源的论据将被视为无效！`;
  }

  // ========== 总结陈词 (closing_con / closing_pro) ==========
  if (phaseName.startsWith('closing')) {
    // Build full debate history for closing
    const allHistory = debateState.history.map(h => {
      const posLabel = h.position === 'pro' ? '正方' : '反方';
      const phaseLabel = DEBATE_PHASE_NAMES[h.phase] || h.phase;
      return `[${posLabel} - ${phaseLabel}]\n${h.content}`;
    }).join('\n\n---\n\n');

    const closingNote = phaseName === 'closing_pro'
      ? '\n\n【注意】你是最后发言者，这是你的最后机会做出有力结论！'
      : '';

    return `这是辩论的【总结陈词阶段】。${closingNote}

辩题：${topic}
你的立场：${positionLabel}

【辩论完整记录】
${allHistory}

请进行总结陈词：
1. 总结你的核心观点和主要论据
2. 回应对方最有力的反驳
3. 强调你方观点的优势
4. 做出有力的结论性陈述
5. 篇幅控制在 200-400 字`;
  }

  // Fallback
  return `辩题：${topic}\n你的立场：${positionLabel}\n请继续辩论。`;
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

  // 并行获取双方最新回复（使用 Promise.all 避免串行等待）
  const [proResponse, conResponse] = await Promise.all([
    getLatestResponse(debateState.proAI),
    getLatestResponse(debateState.conAI)
  ]);

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

  // Use the user-selected judge
  const judge = debateState.judgeAI;

  // Build full debate transcript
  const transcript = debateState.history.map(h => {
    const posLabel = h.position === 'pro' ? '正方' : '反方';
    const aiLabel = capitalize(h.ai);
    const phaseLabel = DEBATE_PHASE_NAMES[h.phase];
    return `[${posLabel} (${aiLabel}) - ${phaseLabel}]\n${h.content}`;
  }).join('\n\n' + '='.repeat(50) + '\n\n');

  const getVerdictPrompt = (judgeAI) => `你是本场辩论的【独立裁判】，需要完成两个独立的评估任务：

📋 任务说明：
1. 【辩论技巧评分】- 评价谁"辩得更好"（与观点对错无关）
2. 【事实裁决】- 判断哪个观点"更接近真相"（需要你自己调研）

辩题：${debateState.topic}
正方：${capitalize(debateState.proAI)}（支持该观点）
反方：${capitalize(debateState.conAI)}（反对该观点）

辩论记录：
${'='.repeat(50)}
${transcript}
${'='.repeat(50)}

════════════════════════════════════════
第一部分：【辩论技巧评分】
════════════════════════════════════════

⚠️ 重要：此部分仅评估辩论技巧，不考虑观点本身对错！
即使某方的观点是错的，如果辩论技巧出色，仍应给高分。

评估维度（每项20分，共100分）：
1. 逻辑清晰度 - 论点是否条理分明、层次清楚
2. 论证能力 - 论据是否有力支撑论点
3. 反驳能力 - 对对方观点的回应是否有效
4. 表达技巧 - 语言是否精准、有说服力
5. 整体连贯性 - 全程论述是否前后一致、有深度

请给出具体分析和打分。

════════════════════════════════════════
第二部分：【事实裁决】
════════════════════════════════════════

⚠️ 重要：此部分是你作为裁判的独立判断，基于事实和推理！
你需要：
1. 核实双方引用的来源（真实/虚假/断章取义）
2. 进行你自己的网络搜索和资料收集
3. 结合你的知识和分析能力
4. 判断哪个观点更接近客观真相

请提供：
- 来源核实结果
- 你自己搜集到的关键证据
- 你的分析推理过程
- 最终倾向判断

════════════════════════════════════════
第三部分：【风险提示】
════════════════════════════════════════

如果根据本辩论结果做决策，最大风险是什么？
是否有双方都遗漏的重要因素？

════════════════════════════════════════

⚠️ 【极重要】请在回复最后，严格按以下格式输出结果：
- 不要使用Markdown代码块
- 必须包含开头和结尾标记
- 所有字段必须填写

===审计结果===
【辩论技巧】
技巧胜方：[正方/反方/平局] (谁辩得更好)
正方技巧分：[0-100]
反方技巧分：[0-100]
技巧评语：[一句话点评辩论表现]

【事实裁决】
事实倾向：[正方观点/反方观点/证据不足/各有道理]
来源可信度-正方：[1-5]星
来源可信度-反方：[1-5]星
裁判补充证据：[你自己搜集到的关键信息，简述]
裁决理由：[基于事实和推理，为什么倾向这一方]

【风险提示】
致命风险：[一句话描述]
===============

⚠️ 缺少结尾 =============== 将导致结果无效！`;

  log(`[审计] 裁判 ${capitalize(judge)} 正在进行尽职调查...`);

  // Send to the selected judge
  await sendToAI(judge, getVerdictPrompt(judge));

  // Clear any existing polling before starting new one
  cleanupVerdictPolling();

  // Wait for verdict with polling
  let attempts = 0;
  const maxAttempts = 300; // 10 minutes max (300 * 2s = 600s) - AI needs time for deep analysis with web search

  verdictPollingInterval = setInterval(async () => {
    // Safety check: stop if debate was reset during polling
    if (!debateState.active) {
      cleanupVerdictPolling();
      return;
    }

    attempts++;

    const response = await getLatestResponse(judge);
    if (response && response.includes('===审计结果===')) {
      debateState.verdict = response;
      log(`[审计] ${capitalize(judge)} 已提交审计报告`, 'success');
      cleanupVerdictPolling();
      processSingleJudgeVerdict(judge, response);
      return;
    }

    updateDebateStatus('waiting', `等待 ${capitalize(judge)} 的审计报告...`);

    // Timeout
    if (attempts >= maxAttempts) {
      cleanupVerdictPolling();
      log(`[审计] 超时，${capitalize(judge)} 未能提交报告`, 'error');
      updateDebateStatus('ready', '审计超时，请重试');
      document.getElementById('request-verdict-btn').disabled = false;
    }
  }, 2000);
}

function processSingleJudgeVerdict(judge, verdictText) {
  log(`[裁决] 正在分析 ${capitalize(judge)} 的审计报告...`);

  const parsed = parseVerdictResult(verdictText);

  if (!parsed.valid) {
    log('[裁决] ❌ 审计报告格式无效', 'error');
    showSingleJudgeVerdict(judge, parsed, 'invalid', '');
    return;
  }

  // --- STRICT RELIABILITY CHECK ---
  let riskFlag = false;
  let riskReason = '';

  // 1. Check for Low Credibility Sources (<= 2 stars, but only if parsed)
  const hasCredibilityData = parsed.proCredibility > 0 || parsed.conCredibility > 0;
  if (hasCredibilityData && (parsed.proCredibility <= 2 || parsed.conCredibility <= 2)) {
    riskFlag = true;
    riskReason = '来源可信度过低 (存在虚假或低质来源)';
  }

  // 2. Check for Missing Judge Research (new model: judge should provide evidence/reasoning)
  if (!riskFlag && !parsed.judgeEvidence && !parsed.verdictReason) {
    riskFlag = true;
    riskReason = '裁判未提供独立调研或裁决理由';
  }

  // 3. Check for Low Skill Scores (< 60 is weak, only if scores were parsed)
  const hasSkillScores = parsed.proSkillScore > 0 || parsed.conSkillScore > 0;
  if (!riskFlag && hasSkillScores && parsed.proSkillScore < 60 && parsed.conSkillScore < 60) {
    riskFlag = true;
    riskReason = '双方辩论技巧均未达标 (<60分)';
  }

  // --- DETERMINE CONSENSUS LEVEL ---
  let consensusLevel = 'single_judge';

  if (riskFlag) {
    consensusLevel = 'risk_flagged';
  } else if (parsed.skillWinner === '平局' && parsed.factVerdict.includes('各有')) {
    consensusLevel = 'disputed';
  }

  showSingleJudgeVerdict(judge, parsed, consensusLevel, riskReason);
}

function showSingleJudgeVerdict(judge, parsed, consensusLevel, riskReason) {
  document.getElementById('debate-active').classList.add('hidden');
  document.getElementById('debate-verdict').classList.remove('hidden');

  // 技巧胜方样式
  let skillWinnerClass = 'tie';
  if (parsed.skillWinner === '正方') skillWinnerClass = 'pro';
  else if (parsed.skillWinner === '反方') skillWinnerClass = 'con';

  // 事实倾向样式
  let factVerdictClass = 'tie';
  if (parsed.factVerdict.includes('正方')) factVerdictClass = 'pro';
  else if (parsed.factVerdict.includes('反方')) factVerdictClass = 'con';
  else if (parsed.factVerdict.includes('不足') || parsed.factVerdict.includes('各有')) factVerdictClass = 'risk';

  const consensusLabels = {
    single_judge: '⚖️ 裁判裁决',
    risk_flagged: '⛔️ 风险警报 (自动熔断)',
    disputed: '⚠️ 存在争议',
    invalid: '❌ 无效审计'
  };

  // Check for low credibility (only if data was parsed)
  const hasCredibilityData = parsed.proCredibility > 0 || parsed.conCredibility > 0;
  const isLowCred = hasCredibilityData && (parsed.proCredibility <= 2 || parsed.conCredibility <= 2);

  // 安全：所有 AI 输出都需要转义，防止 XSS
  const safeSkillWinner = escapeHtml(parsed.skillWinner);
  const safeFactVerdict = escapeHtml(parsed.factVerdict);
  const safeSkillComment = escapeHtml(parsed.skillComment);
  const safeJudgeEvidence = escapeHtml(parsed.judgeEvidence);
  const safeVerdictReason = escapeHtml(parsed.verdictReason);
  const safeCriticalRisk = escapeHtml(parsed.criticalRisk);
  const safeRiskReason = escapeHtml(riskReason);

  let html = `
    <div class="consensus-badge ${consensusLevel}">${consensusLabels[consensusLevel] || '未知状态'}</div>
    ${riskReason ? `<div class="risk-alert">⚠️ 熔断原因: ${safeRiskReason}</div>` : ''}

    <!-- 两个独立的评判结果 -->
    <div class="dual-verdict">
      <!-- 辩论技巧评分 -->
      <div class="verdict-section skill-section">
        <h4>🎯 辩论技巧评分</h4>
        <p class="section-subtitle">（谁辩得更好，与观点对错无关）</p>
        <div class="verdict-winner ${skillWinnerClass}">${safeSkillWinner}</div>
        <div class="verdict-scores">
          <span class="score pro">正方: ${parsed.proSkillScore}分</span>
          <span class="score con">反方: ${parsed.conSkillScore}分</span>
        </div>
        ${safeSkillComment ? `<div class="skill-comment">💬 ${safeSkillComment}</div>` : ''}
      </div>

      <!-- 事实裁决 -->
      <div class="verdict-section fact-section">
        <h4>📊 事实裁决</h4>
        <p class="section-subtitle">（基于证据和裁判调研）</p>
        <div class="verdict-winner ${factVerdictClass}">${safeFactVerdict}</div>
        <div class="credibility-scores ${isLowCred ? 'low-credibility' : ''}">
          <span>来源可信度: ⭐${parsed.proCredibility} vs ⭐${parsed.conCredibility}</span>
        </div>
        ${safeJudgeEvidence ? `<div class="judge-evidence">📌 裁判补充: ${safeJudgeEvidence}</div>` : ''}
        ${safeVerdictReason ? `<div class="verdict-reason">📝 裁决理由: ${safeVerdictReason}</div>` : ''}
      </div>
    </div>

    <!-- 风险提示 -->
    <div class="risk-section">
      <h4>⚠️ 风险提示</h4>
      <div class="judge-risk">${safeCriticalRisk}</div>
    </div>

    <!-- 裁判信息 -->
    <div class="judge-info">
      <span class="judge-label">裁判:</span>
      <span class="judge-name">${capitalize(judge)}</span>
    </div>

    <details class="verdict-details">
      <summary>查看详细审计报告</summary>
      <div class="full-verdict">
        <div class="verdict-text">${escapeHtml(parsed.rawText.replace(/===审计结果===[\s\S]*?===============/, '').trim())}</div>
      </div>
    </details>
  `;

  document.getElementById('verdict-content').innerHTML = html;
  debateState.active = false;

  // 日志显示两个结果
  log(`[审计完成] 技巧胜方: ${parsed.skillWinner} | 事实倾向: ${parsed.factVerdict}`,
      consensusLevel === 'risk_flagged' ? 'error' : 'success');
}

// Keep old function for backwards compatibility (not used with single judge)
function processConsensusVerdict() {
  const verdicts = debateState.verdicts;
  const allJudges = Object.keys(verdicts);

  log(`[裁决] 正在分析 ${allJudges.length} 位裁判的报告...`);

  // Parse all verdicts
  const parsedVerdicts = {};
  const validJudges = [];

  for (const judge of allJudges) {
    parsedVerdicts[judge] = parseVerdictResult(verdicts[judge]);
    if (parsedVerdicts[judge].valid) {
      validJudges.push(judge);
      log(`[裁决] ✓ ${capitalize(judge)} 报告有效`, 'success');
    } else {
      log(`[裁决] ⚠️ ${capitalize(judge)} 报告格式无效`, 'error');
    }
  }

  if (validJudges.length === 0) {
    log('[裁决] ❌ 没有有效审计报告', 'error');
    showConsensusVerdict(parsedVerdicts, '无法判定', 'invalid', { '正方': 0, '反方': 0, '平局': 0 }, 0);
    return;
  }

  // --- COLLECT VOTES FROM ALL JUDGES ---
  const winnerVotes = { '正方': 0, '反方': 0, '平局': 0, '资料不足': 0 };
  let totalRiskFlags = 0;
  let riskReasons = [];

  for (const judge of validJudges) {
    const v = parsedVerdicts[judge];

    // Count votes
    if (winnerVotes.hasOwnProperty(v.winner)) {
      winnerVotes[v.winner]++;
    } else {
      winnerVotes['资料不足']++;
    }

    // Check for risk flags from each judge
    if (v.proCredibility <= 2 || v.conCredibility <= 2) {
      totalRiskFlags++;
      riskReasons.push(`${capitalize(judge)}: 来源可信度过低`);
    }
    if (v.proReasoning === '无' && v.conReasoning === '无') {
      totalRiskFlags++;
      riskReasons.push(`${capitalize(judge)}: 双方缺乏思考整合`);
    }
    if (v.proScore < 70 && v.conScore < 70) {
      totalRiskFlags++;
      riskReasons.push(`${capitalize(judge)}: 双方得分过低`);
    }
  }

  // --- DETERMINE CONSENSUS ---
  let consensusWinner = '';
  let consensusLevel = '';
  let riskReason = '';

  // If majority flagged risk, trigger risk mode
  if (totalRiskFlags >= validJudges.length) {
    consensusWinner = '高风险/资料不足';
    consensusLevel = 'risk_flagged';
    riskReason = riskReasons[0] || '多项风险指标触发';
  } else {
    // Find the winner with most votes
    const sortedVotes = Object.entries(winnerVotes)
      .filter(([_, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);

    if (sortedVotes.length === 0) {
      consensusWinner = '无法判定';
      consensusLevel = 'invalid';
    } else if (sortedVotes[0][1] === validJudges.length) {
      // All judges agree - unanimous!
      consensusWinner = sortedVotes[0][0];
      consensusLevel = 'unanimous';
      log(`[裁决] 🏆 全票通过: ${consensusWinner}`, 'success');
    } else if (sortedVotes.length > 1 && sortedVotes[0][1] === sortedVotes[1][1]) {
      // Tie between judges - use average scores to decide
      let avgProScore = 0, avgConScore = 0;
      for (const j of validJudges) {
        avgProScore += parsedVerdicts[j].proScore;
        avgConScore += parsedVerdicts[j].conScore;
      }
      avgProScore /= validJudges.length;
      avgConScore /= validJudges.length;

      if (avgProScore > avgConScore + 5) {
        consensusWinner = '正方';
        consensusLevel = 'disputed';
        log(`[裁决] 裁判意见分歧，按均分判定: 正方 (${avgProScore.toFixed(0)} vs ${avgConScore.toFixed(0)})`, 'success');
      } else if (avgConScore > avgProScore + 5) {
        consensusWinner = '反方';
        consensusLevel = 'disputed';
        log(`[裁决] 裁判意见分歧，按均分判定: 反方 (${avgConScore.toFixed(0)} vs ${avgProScore.toFixed(0)})`, 'success');
      } else {
        consensusWinner = '平局';
        consensusLevel = 'disputed';
        log(`[裁决] 裁判意见分歧且分数接近，判定平局`, 'success');
      }
    } else {
      // Majority decision
      consensusWinner = sortedVotes[0][0];
      consensusLevel = validJudges.length > 1 ? 'majority' : 'single_judge';
      log(`[裁决] ${validJudges.length > 1 ? '多数通过' : '裁判裁决'}: ${consensusWinner}`, 'success');
    }
  }

  showConsensusVerdict(parsedVerdicts, consensusWinner, consensusLevel, winnerVotes, validJudges.length, riskReason);
}

function parseVerdictResult(verdict) {
  const result = {
    valid: false,
    // 辩论技巧评分（谁辩得更好）
    skillWinner: '平局',
    proSkillScore: 0,
    conSkillScore: 0,
    skillComment: '',
    // 事实裁决（哪个观点更接近真相）
    factVerdict: '证据不足',
    proCredibility: 0,
    conCredibility: 0,
    judgeEvidence: '',  // 裁判补充的证据
    verdictReason: '',  // 裁决理由
    // 风险提示
    criticalRisk: '无',
    // 原始数据
    rawText: verdict,
    parseErrors: [],
    // 兼容旧格式的字段（用于显示）
    winner: '平局',
    proScore: 0,
    conScore: 0
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

  // 辅助正则模式：容忍 Markdown 格式（单行）
  const fieldPattern = (name) => new RegExp(
    `(?:[-*]?\\s*)?(?:\\*{1,2})?${name}(?:\\*{1,2})?[：:]\\s*(?:\\*{1,2})?(.+?)(?:\\*{1,2})?$`, 'm'
  );
  const numberPattern = (name) => new RegExp(
    `(?:[-*]?\\s*)?(?:\\*{1,2})?${name}(?:\\*{1,2})?[：:]\\s*(?:\\*{1,2})?(\\d+)`
  );

  // 多行字段解析：捕获到下一个【标题】或字段名之前的所有内容
  const multiLineFieldPattern = (name) => new RegExp(
    `(?:[-*]?\\s*)?(?:\\*{1,2})?${name}(?:\\*{1,2})?[：:]\\s*([\\s\\S]*?)(?=(?:【|裁判补充|裁决理由|致命风险|来源可信度|$))`, 'i'
  );

  // 增强的星级解析：支持 ⭐5, 5星, 5 星, 五星, 4/5 等格式
  const parseCredibility = (text) => {
    if (!text) return 0;
    // 数字格式：5, ⭐5, 5星, 5 星, 4/5
    const numMatch = text.match(/[⭐★]?\s*(\d)\s*[星\/]?/);
    if (numMatch) return parseInt(numMatch[1]);
    // 中文数字格式：一星 到 五星
    const chineseNums = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5 };
    const chineseMatch = text.match(/([一二三四五])\s*星/);
    if (chineseMatch) return chineseNums[chineseMatch[1]] || 0;
    return 0;
  };

  // ========== 辩论技巧部分 ==========

  // 技巧胜方
  const skillWinnerMatch = block.match(fieldPattern('技巧胜方'));
  if (skillWinnerMatch) {
    result.skillWinner = skillWinnerMatch[1].trim().replace(/\*+/g, '').replace(/\s*\(.*\)/, '');
  }

  // 正方技巧分
  const proSkillMatch = block.match(numberPattern('正方技巧分'));
  if (proSkillMatch) result.proSkillScore = parseInt(proSkillMatch[1]);

  // 反方技巧分
  const conSkillMatch = block.match(numberPattern('反方技巧分'));
  if (conSkillMatch) result.conSkillScore = parseInt(conSkillMatch[1]);

  // 技巧评语
  const skillCommentMatch = block.match(fieldPattern('技巧评语'));
  if (skillCommentMatch) result.skillComment = skillCommentMatch[1].trim().replace(/\*+/g, '');

  // ========== 事实裁决部分 ==========

  // 事实倾向
  const factVerdictMatch = block.match(fieldPattern('事实倾向'));
  if (factVerdictMatch) {
    result.factVerdict = factVerdictMatch[1].trim().replace(/\*+/g, '');
  }

  // 来源可信度-正方（增强解析）
  const proCredMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?来源可信度.?正方(?:\*{1,2})?[：:]\s*(.+?)$/m);
  if (proCredMatch) result.proCredibility = parseCredibility(proCredMatch[1]);

  // 来源可信度-反方（增强解析）
  const conCredMatch = block.match(/(?:[-*]?\s*)?(?:\*{1,2})?来源可信度.?反方(?:\*{1,2})?[：:]\s*(.+?)$/m);
  if (conCredMatch) result.conCredibility = parseCredibility(conCredMatch[1]);

  // 裁判补充证据（多行支持）
  const judgeEvidenceMatch = block.match(multiLineFieldPattern('裁判补充证据'));
  if (judgeEvidenceMatch) {
    result.judgeEvidence = judgeEvidenceMatch[1].trim().replace(/\*+/g, '').replace(/\n+/g, ' ');
  }

  // 裁决理由（多行支持）
  const verdictReasonMatch = block.match(multiLineFieldPattern('裁决理由'));
  if (verdictReasonMatch) {
    result.verdictReason = verdictReasonMatch[1].trim().replace(/\*+/g, '').replace(/\n+/g, ' ');
  }

  // ========== 风险提示 ==========

  // 致命风险
  const riskMatch = block.match(fieldPattern('致命风险'));
  if (riskMatch) result.criticalRisk = riskMatch[1].trim().replace(/\*+/g, '');

  // ========== 兼容性处理 ==========

  // 设置兼容旧格式的字段
  result.winner = result.skillWinner;  // 主要胜方使用技巧胜方
  result.proScore = result.proSkillScore;
  result.conScore = result.conSkillScore;

  // 判断有效性：只要有技巧胜方或事实倾向字段，就认为有效
  const hasMinimumFields = skillWinnerMatch !== null || factVerdictMatch !== null;
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
    single_judge: '⚖️ 裁判裁决',
    unanimous: '🏆 权威认证 (全票通过)',
    majority: '✅ 多数通过',
    risk_flagged: '⛔️ 风险警报 (自动熔断)',
    disputed: '⚠️ 存在争议',
    invalid: '❌ 无效审计'
  };

  // Build vote summary for 2+ judges
  const voteEntries = Object.entries(votes).filter(([_, count]) => count > 0);
  const voteSummary = voteEntries.map(([winner, count]) => `${winner}: ${count}票`).join(' | ');

  let headerHtml = `
    <div class="consensus-badge ${consensusLevel}">${consensusLabels[consensusLevel] || '未知状态'}</div>
    <div class="verdict-winner ${winnerClass}">${consensusWinner}</div>
  `;

  if (totalValid > 1) {
    headerHtml += `<div class="vote-summary">🗳️ 投票结果: ${voteSummary} (${totalValid}位裁判)</div>`;
  }

  if (riskReason) {
    headerHtml += `<div class="risk-alert">⚠️ 熔断原因: ${riskReason}</div>`;
  }

  // Judge Cards (multiple impartial judges)
  const judgeCount = judges.length;
  let judgeBreakdown = `<div class="judge-breakdown"><h4>裁判团审计报告 (${judgeCount}位裁判)：</h4>`;
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
    judgeAI: null,
    currentPhase: 0,
    history: [],
    pendingResponses: new Set(),
    phaseInFlight: false,
    lateResponses: [],
    verdict: null
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
