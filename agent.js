#!/usr/bin/env node
/**
 * AI Club League Agent - Web Dashboard Compatible
 * PvP match finding with configurable settings
 */

import WebSocket from "ws";
import { existsSync, readFileSync, writeFileSync } from "fs";

// ── Load User Config ─────────────────────────────────────────────────────────
let API_KEY, AGENT_NAME, userStrategy = "balanced", userTactics = {};

try {
  if (existsSync("./config.json")) {
    const config = JSON.parse(readFileSync("./config.json", "utf8"));
    API_KEY = config.apiKey || "your-api-key";
    AGENT_NAME = config.agentName || "MyAgent";
    userStrategy = config.strategy || "balanced";
    userTactics = config.tactics || {};
    console.log(`📝 Config loaded: ${AGENT_NAME} (${userStrategy})`);
  } else {
    API_KEY = "your-api-key";
    AGENT_NAME = "MyAgent";
  }
} catch (e) {
  console.log("⚠️ No config found, using defaults");
  API_KEY = "your-api-key";
  AGENT_NAME = "MyAgent";
}

const WS_URL     = "wss://game.agentsleague.net/agent";
const REST_URL   = "https://game.agentsleague.net";
const BRAIN_FILE = "./BRAIN.md";

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  reset:"\x1b[0m", bold:"\x1b[1m",
  cyan:"\x1b[36m", green:"\x1b[32m", yellow:"\x1b[33m",
  red:"\x1b[31m",  magenta:"\x1b[35m", gray:"\x1b[90m",
  blue:"\x1b[34m", white:"\x1b[97m",
};
const c = (col, s) => `${C[col]}${s}${C.reset}`;
const log = (col, ...args) => console.log(c(col, args.join(" ")));
const bold = s => `${C.bold}${s}${C.reset}`;
const now = () => new Date().toLocaleTimeString();
const tag = (label, col = "gray") => c(col, `[${now()}] [${label}]`);

// ── State ─────────────────────────────────────────────────────────────────────
let ws;
let agentId = null;
let matchId = null;
let mySide = null;
let currentStrat = "balanced";
let score = { home: 0, away: 0 };
let matchMinute = 0;
let inMatch = false;
let consecutiveWins = 0;
let consecutiveLosses = 0;
let totalMatches = 0;
let totalWins = 0;
let mySquad = [];
let opponentName = "?";
let reconnectDelay = 3000;
let currentTickSeq = 0;
let players = {};
let ballState = null;
let lastGoalMinute = 0;
let goalsConcededStreak = 0;
let goalsScoredStreak = 0;
let shotsOnTarget = { home: 0, away: 0 };
let totalShots = { home: 0, away: 0 };

// ── Tactical sliders (0-1) ────────────────────────────────────────────────────
let tactical = {
  philosophy: userTactics.pressing ? 0.5 + (parseFloat(userTactics.pressing) - 0.5) : 0.6,
  pressing: parseFloat(userTactics.pressing) || 0.7,
  width: parseFloat(userTactics.width) || 0.5,
  tempo: parseFloat(userTactics.tempo) || 0.65,
  lineHeight: 0.55
};

// ── Brain ─────────────────────────────────────────────────────────────────────
const brain = {
  playbooks: {
    "balanced":       { wins: 0, losses: 0, draws: 0, goalsFor: 0, goalsAgainst: 0 },
    "tiki-taka":      { wins: 0, losses: 0, draws: 0, goalsFor: 0, goalsAgainst: 0 },
    "counter-attack": { wins: 0, losses: 0, draws: 0, goalsFor: 0, goalsAgainst: 0 },
    "high-press":     { wins: 0, losses: 0, draws: 0, goalsFor: 0, goalsAgainst: 0 },
    "park-the-bus":   { wins: 0, losses: 0, draws: 0, goalsFor: 0, goalsAgainst: 0 }
  },
  opponents: {},
  formTrend: []
};

const saveBrain = () => {
  const winRate = totalMatches > 0 ? ((totalWins / totalMatches) * 100).toFixed(1) : 0;
  const lines = [
    `# ${AGENT_NAME} Brain`,
    `Updated: ${new Date().toISOString()}`,
    `Matches: ${totalMatches} | Wins: ${totalWins} | WR: ${winRate}%`,
    `Consecutive wins: ${consecutiveWins} | Losses: ${consecutiveLosses}`,
    "",
    "## Playbook Performance",
    ...Object.entries(brain.playbooks).map(([k, v]) => {
      const total = v.wins + v.losses + v.draws;
      const wr = total > 0 ? ((v.wins / total) * 100).toFixed(0) + "%" : "—";
      const gd = v.goalsFor - v.goalsAgainst;
      return `- ${k.padEnd(14)} W:${v.wins} L:${v.losses} D:${v.draws} GF:${v.goalsFor} GA:${v.goalsAgainst} GD:${gd} WR:${wr}`;
    }),
    "",
    "## Recent Form",
    brain.formTrend.map(v => v === 1 ? "✅" : v === 0.5 ? "🤝" : "❌").join(" ")
  ];
  writeFileSync(BRAIN_FILE, lines.join("\n"));
};

const loadBrain = () => {
  if (!existsSync(BRAIN_FILE)) return;
  try {
    const txt = readFileSync(BRAIN_FILE, "utf8");
    const tw = txt.match(/Matches: (\d+)/);
    const ww = txt.match(/Wins: (\d+)/);
    if (tw) totalMatches = parseInt(tw[1]);
    if (ww) totalWins = parseInt(ww[1]);
  } catch (e) {
    console.log("Could not load brain file");
  }
};

// ── WebSocket send ────────────────────────────────────────────────────────────
const send = (obj) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

const sendCommands = (commands, reasoning = "") => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send({
    type: "AGENT_COMMANDS",
    seq: currentTickSeq,
    commands,
    meta: { reasoning, confidence: 0.85 }
  });
};

const sendTactical = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send({
    type: "AGENT_TACTICAL",
    seq: currentTickSeq,
    config: tactical,
    meta: { reasoning: "Tactical adjustment", confidence: 0.9 }
  });
};

// ── Squad Analysis ────────────────────────────────────────────────────────────
const analyzeSquad = () => {
  if (!mySquad.length) return null;
  
  const analysis = {
    avgSpeed: 0, avgPassing: 0, avgFinishing: 0, avgStamina: 0, avgDefense: 0,
    playmakers: 0, clinical: 0, aggressive: 0
  };
  
  let speedSum = 0, passSum = 0, finishSum = 0, staminaSum = 0, defSum = 0;
  
  for (const p of mySquad) {
    const att = p.attributes || {};
    speedSum += (att.speed || 50);
    passSum += ((att.shortPass || 50) + (att.longPass || 50)) / 2;
    finishSum += (att.finishing || 50);
    staminaSum += (att.stamina || 50);
    defSum += ((att.tackling || 50) + (att.marking || 50)) / 2;
    
    if (p.traits?.includes("PLAYMAKER")) analysis.playmakers++;
    if (p.traits?.includes("CLINICAL")) analysis.clinical++;
    if (p.traits?.includes("AGGRESSIVE")) analysis.aggressive++;
  }
  
  const count = mySquad.length;
  analysis.avgSpeed = speedSum / count;
  analysis.avgPassing = passSum / count;
  analysis.avgFinishing = finishSum / count;
  analysis.avgStamina = staminaSum / count;
  analysis.avgDefense = defSum / count;
  
  return analysis;
};

const chooseOpeningStrat = () => {
  // Use user-configured strategy if set
  if (userStrategy && userStrategy !== "balanced") {
    return userStrategy;
  }
  
  const analysis = analyzeSquad();
  if (!analysis) return "balanced";
  
  if (analysis.playmakers >= 2 && analysis.avgPassing > 65) return "tiki-taka";
  if (analysis.clinical >= 2 && analysis.avgFinishing > 65) return "counter-attack";
  if (analysis.aggressive >= 2 && analysis.avgStamina > 60) return "high-press";
  if (analysis.avgDefense > 65) return "park-the-bus";
  return "balanced";
};

// ── Match Situation Analysis ─────────────────────────────────────────────────
const analyzeMatchSituation = () => {
  const myGoals = mySide === "home" ? score.home : score.away;
  const oppGoals = mySide === "home" ? score.away : score.home;
  const diff = myGoals - oppGoals;
  const timeLeft = 90 - matchMinute;
  const isLateGame = timeLeft <= 15;
  const isDesperateMode = diff < 0 && timeLeft <= 10;
  const isProtectMode = diff > 0 && timeLeft <= 10;
  
  return { myGoals, oppGoals, diff, timeLeft, isLateGame, isDesperateMode, isProtectMode };
};

const decideTactics = () => {
  const { diff, timeLeft, isDesperateMode, isProtectMode } = analyzeMatchSituation();
  
  if (isDesperateMode || (diff < -1 && timeLeft <= 20)) {
    tactical = { philosophy: 1.0, pressing: 1.0, width: 0.8, tempo: 0.9, lineHeight: 0.2 };
    currentStrat = "high-press";
    sendTactical();
    return "ULTRA ATTACK - chasing the game";
  }
  
  if (isProtectMode || (diff >= 2 && timeLeft <= 25)) {
    tactical = { philosophy: 0.2, pressing: 0.3, width: 0.4, tempo: 0.3, lineHeight: 0.8 };
    currentStrat = "park-the-bus";
    sendTactical();
    return "PARK THE BUS - protecting lead";
  }
  
  if (diff > 0) {
    tactical = { philosophy: 0.4, pressing: 0.5, width: 0.5, tempo: 0.4, lineHeight: 0.6 };
    currentStrat = "tiki-taka";
  } else if (diff < 0) {
    tactical = { philosophy: 0.8, pressing: 0.8, width: 0.6, tempo: 0.7, lineHeight: 0.4 };
    currentStrat = "counter-attack";
  } else {
    tactical = { philosophy: 0.55, pressing: 0.6, width: 0.5, tempo: 0.55, lineHeight: 0.5 };
    currentStrat = "balanced";
  }
  
  sendTactical();
  return `Tactical adjustment: ${currentStrat}`;
};

// ── Match Control ────────────────────────────────────────────────────────────
const startMatch = () => {
  const strat = chooseOpeningStrat();
  currentStrat = strat;
  score = { home: 0, away: 0 };
  matchMinute = 0;
  inMatch = true;
  goalsConcededStreak = 0;
  goalsScoredStreak = 0;
  shotsOnTarget = { home: 0, away: 0 };
  totalShots = { home: 0, away: 0 };
  
  // MODIFIED: Using AGENT_FIND_PVP as requested
  send({
    type: "AGENT_FIND_PVP",
    maxRatingGap: 150,
    strategy: strat
  });
  
  console.log(`${tag("BOT","blue")} 🎮 Joining PvP queue with ${c("cyan", strat)} (max rating gap: 150)`);
};

// ── Per-Player Commands ──────────────────────────────────────────────────────
const getFormationPositions = () => {
  const { isDesperateMode, isProtectMode } = analyzeMatchSituation();
  
  if (isDesperateMode) {
    return {
      GK: { x: 50, y: 300 },
      DEF: [{ x: 200, y: 250 }, { x: 200, y: 350 }],
      MF: [{ x: 400, y: 250 }, { x: 400, y: 350 }],
      FWD: [{ x: 650, y: 300 }]
    };
  }
  
  if (isProtectMode) {
    return {
      GK: { x: 50, y: 300 },
      DEF: [{ x: 150, y: 240 }, { x: 150, y: 360 }],
      MF: [{ x: 300, y: 240 }, { x: 300, y: 360 }],
      FWD: [{ x: 450, y: 300 }]
    };
  }
  
  return {
    GK: { x: 60, y: 300 },
    DEF: [{ x: 200, y: 240 }, { x: 200, y: 360 }],
    MF: [{ x: 380, y: 300 }],
    FWD: [{ x: 550, y: 240 }, { x: 550, y: 360 }]
  };
};

const findBestPassTarget = (carrier, teammates, ballX, ballY, oppPlayers) => {
  let bestTarget = null;
  let bestScore = -Infinity;
  
  for (const teammate of teammates) {
    if (teammate.id === carrier.id) continue;
    
    const dx = teammate.x - carrier.x;
    const dy = teammate.y - carrier.y;
    const distance = Math.hypot(dx, dy);
    
    if (distance > 400) continue;
    
    let interceptRisk = 0;
    if (oppPlayers) {
      for (const opp of oppPlayers) {
        const oppDist = Math.hypot(opp.x - carrier.x, opp.y - carrier.y);
        if (oppDist < distance * 0.7 && oppDist < 150) {
          interceptRisk += 0.3;
        }
      }
    }
    
    const isForward = teammate.x > carrier.x;
    const score = (isForward ? 1.5 : 0.5) * (1 - interceptRisk) * (1 / (distance / 200));
    
    if (score > bestScore) {
      bestScore = score;
      bestTarget = teammate.id;
    }
  }
  
  return bestTarget;
};

const generatePerPlayerCommands = (obs) => {
  const commands = [];
  const formation = getFormationPositions();
  const myPlayers = obs.myPlayers || [];
  const oppPlayers = obs.oppPlayers || [];
  const ball = obs.ball;
  const ballX = ball?.x || 400;
  const ballY = ball?.y || 300;
  const ballCarrier = myPlayers.find(p => p.hasBall);
  const { isDesperateMode, diff } = analyzeMatchSituation();
  
  for (const player of myPlayers) {
    const role = player.role;
    let pos = null;
    
    // GOALKEEPER
    if (role === "GK") {
      const goalY = Math.min(540, Math.max(60, ballY * 0.7 + 90));
      pos = { x: 40, y: goalY };
    }
    // DEFENDERS
    else if (role === "DEF") {
      const defPositions = formation.DEF;
      const closestDef = defPositions.reduce((a, b) => {
        return Math.hypot(a.x - player.x, a.y - player.y) < Math.hypot(b.x - player.x, b.y - player.y) ? a : b;
      });
      if (ballX < 300 && !ballCarrier) {
        pos = { x: Math.min(250, ballX + 50), y: Math.min(500, Math.max(100, ballY)) };
      } else {
        pos = closestDef;
      }
    }
    // MIDFIELDER
    else if (role === "MF") {
      if (ballCarrier?.id === player.id) {
        pos = { x: Math.min(700, ballX + 30), y: ballY };
      } else if (ballX > 400 && !ballCarrier) {
        pos = { x: Math.min(600, ballX - 20), y: Math.min(500, Math.max(100, ballY)) };
      } else {
        pos = formation.MF[0];
      }
    }
    // FORWARDS
    else if (role === "FWD") {
      if (ballCarrier?.id === player.id) {
        if (ballX > 550) {
          const targetY = ballY < 300 ? 240 : 360;
          commands.push({ playerId: player.id, action: { type: "SHOOT_AIMED", targetX: 780, targetY } });
        }
        pos = { x: Math.min(770, ballX + 40), y: Math.min(500, Math.max(100, ballY)) };
      } else if (isDesperateMode || diff < 0) {
        pos = { x: 720, y: ballY };
      } else {
        const fwdPositions = formation.FWD;
        pos = fwdPositions[Math.floor(Math.random() * fwdPositions.length)];
      }
    }
    
    if (pos) {
      commands.push({ playerId: player.id, action: { type: "MOVE", targetX: pos.x, targetY: pos.y } });
    }
    
    // Smart passing
    if (ballCarrier?.id === player.id && player.canAct && ballX <= 550) {
      const teammates = myPlayers.filter(p => p.id !== player.id);
      const bestPass = findBestPassTarget(player, teammates, ballX, ballY, oppPlayers);
      if (bestPass && !isDesperateMode) {
        commands.push({ playerId: player.id, action: { type: "PASS", targetPlayerId: bestPass } });
      }
    }
    
    // Tackling
    const nearestOpp = oppPlayers.find(p => {
      const dx = p.x - player.x;
      const dy = p.y - player.y;
      return Math.hypot(dx, dy) < 40 && p.hasBall;
    });
    
    if (nearestOpp && player.canAct) {
      commands.push({ playerId: player.id, action: { type: "TACKLE" } });
    }
  }
  
  return commands;
};

// ── Squad Loading ────────────────────────────────────────────────────────────
const loadSquad = async () => {
  if (!agentId) return;
  try {
    const { default: fetch } = await import("node-fetch");
    const res = await fetch(`${REST_URL}/api/agents/${agentId}/squad`, {
      headers: { "x-api-key": API_KEY }
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.squad) {
        mySquad = data.squad;
        const analysis = analyzeSquad();
        if (analysis) {
          console.log(`${tag("SQUAD","green")} ⚽ Speed:${analysis.avgSpeed.toFixed(0)} Pass:${analysis.avgPassing.toFixed(0)} Finish:${analysis.avgFinishing.toFixed(0)}`);
        }
      }
    }
  } catch (e) {
    console.log(`${tag("SQUAD","yellow")} Could not load squad`);
  }
};

// ── Message Handler ───────────────────────────────────────────────────────────
const onMessage = async (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  
  switch (msg.type) {
    case "AGENT_WELCOME":
      agentId = msg.agentId;
      console.log(`${tag("AUTH","green")} ✅ Connected as ${AGENT_NAME} (ID: ${agentId})`);
      await loadSquad();
      loadBrain();
      startMatch();
      break;
      
    case "AGENT_INIT": {
      const ctx = msg.context || {};
      matchId = msg.matchId;
      score = { home: 0, away: 0 };
      matchMinute = 0;
      inMatch = true;
      goalsConcededStreak = 0;
      goalsScoredStreak = 0;
      
      if (ctx.myTeamId) {
        mySide = ctx.myTeamId;
      } else {
        mySide = msg.mySide || ctx.mySide || "away";
      }
      
      if (ctx.mySquad) {
        mySquad = ctx.mySquad;
      }
      
      if (ctx.opponentName) {
        opponentName = ctx.opponentName;
      }
      
      console.log(`\n${tag("MATCH","cyan")} ⚽ MATCH START - ${mySide.toUpperCase()} vs ${opponentName}`);
      
      sendTactical();
      break;
    }
    
    case "AGENT_OBSERVE":
      currentTickSeq = msg.seq;
      if (msg.gameTime) {
        matchMinute = Math.floor(msg.gameTime / 60);
      }
      if (msg.ball) ballState = msg.ball;
      if (msg.myPlayers) {
        for (const p of msg.myPlayers) {
          players[p.id] = { ...players[p.id], ...p };
        }
      }
      
      if (matchMinute % 10 === 0 || matchMinute < 5) {
        const decision = decideTactics();
        console.log(`${tag("TACTICS","cyan")} ${decision} at ${matchMinute}'`);
      }
      
      const commands = generatePerPlayerCommands(msg);
      if (commands.length > 0) {
        sendCommands(commands, `Minute ${matchMinute}`);
      }
      break;
      
    case "AGENT_EVENT": {
      const ev = msg.event || msg;
      const type = ev.type || "";
      const minute = ev.minute ?? matchMinute;
      
      if (type === "GOAL") {
        const side = ev.side || ev.team;
        if (side === "home") score.home++;
        else if (side === "away") score.away++;
        
        const weScored = (side === mySide);
        const myG = mySide === "home" ? score.home : score.away;
        const oppG = mySide === "home" ? score.away : score.home;
        
        if (weScored) {
          console.log(`${tag("GOAL","green")} ⚽⚽⚽ ${minute}' WE SCORE! [${myG}-${oppG}]`);
          goalsScoredStreak++;
          goalsConcededStreak = 0;
        } else {
          console.log(`${tag("GOAL","red")} ⚽ ${minute}' CONCEDED [${myG}-${oppG}]`);
          goalsConcededStreak++;
          goalsScoredStreak = 0;
        }
        decideTactics();
      }
      
      if (type === "HALF_TIME" || type === "HALFTIME") {
        const myG = mySide === "home" ? score.home : score.away;
        const oppG = mySide === "home" ? score.away : score.home;
        console.log(`${tag("HALF","cyan")} ⏸️ HALF TIME: ${myG}-${oppG}`);
      }
      break;
    }
    
    case "AGENT_MATCH_END": {
      inMatch = false;
      const r = msg.result || {};
      const finalScore = r.score || {};
      const myG = mySide === "home" ? (finalScore.home ?? score.home) : (finalScore.away ?? score.away);
      const oppG = mySide === "home" ? (finalScore.away ?? score.away) : (finalScore.home ?? score.home);
      const outcome = myG > oppG ? "WIN" : myG < oppG ? "LOSS" : "DRAW";
      const col = outcome === "WIN" ? "green" : outcome === "LOSS" ? "red" : "yellow";
      
      totalMatches++;
      if (outcome === "WIN") {
        totalWins++;
        consecutiveWins++;
        consecutiveLosses = 0;
        brain.formTrend = [1, ...brain.formTrend].slice(0, 5);
      } else if (outcome === "LOSS") {
        consecutiveLosses++;
        consecutiveWins = 0;
        brain.formTrend = [0, ...brain.formTrend].slice(0, 5);
      } else {
        consecutiveWins = 0;
        consecutiveLosses = 0;
        brain.formTrend = [0.5, ...brain.formTrend].slice(0, 5);
      }
      
      if (brain.playbooks[currentStrat]) {
        const pb = brain.playbooks[currentStrat];
        if (outcome === "WIN") pb.wins++;
        else if (outcome === "LOSS") pb.losses++;
        else pb.draws++;
        pb.goalsFor += myG;
        pb.goalsAgainst += oppG;
      }
      
      const winRate = totalMatches ? ((totalWins / totalMatches) * 100).toFixed(1) : 0;
      const formDisplay = brain.formTrend.map(v => v === 1 ? "✅" : v === 0.5 ? "🤝" : "❌").join("");
      
      console.log(`\n${tag("END",col)} ${outcome} ${myG}-${oppG} | WR: ${winRate}% | Form: ${formDisplay}`);
      if (msg.rewards) {
        console.log(`${tag("REWARDS","yellow")} 💰 +${msg.rewards.coins || 0} coins, +${msg.rewards.xp || 0} xp`);
      }
      
      saveBrain();
      
      const cooldown = outcome === "WIN" ? 4 : outcome === "LOSS" ? 8 : 6;
      console.log(`${tag("BOT","gray")} ⏳ Next match in ${cooldown}s...`);
      setTimeout(() => {
        if (!inMatch) {
          startMatch();
        }
      }, cooldown * 1000);
      break;
    }
    
    case "AGENT_PVP_FOUND":
    case "AGENT_MATCH_FOUND":
      opponentName = msg.opponentName || msg.matchInfo?.opponentName || "?";
      console.log(`${tag("OPPONENT","yellow")} 🎯 Found opponent: ${opponentName}`);
      break;
      
    case "AGENT_ERROR": {
      const code = msg.code || "ERROR";
      const hint = msg.hint || msg.message || "";
      console.log(`${tag("ERROR","red")} ❌ ${code}: ${hint}`);
      
      if (code === "NO_ENERGY") {
        const waitSec = 60;
        console.log(`${tag("ENERGY","gray")} 🔋 Waiting ${waitSec}s for energy regen...`);
        setTimeout(() => { if (!inMatch) startMatch(); }, waitSec * 1000);
      } else if (!inMatch) {
        setTimeout(() => startMatch(), 5000);
      }
      break;
    }
    
    default:
      if (msg.type && !msg.type.includes("HEARTBEAT")) {
        console.log(`${tag("DEBUG","gray")} 📨 Unknown message type: ${msg.type}`);
      }
  }
};

// ── WebSocket Connection ──────────────────────────────────────────────────────
const connect = () => {
  console.log(bold(c("cyan", "\n⚽  " + AGENT_NAME + " - AI Club League Agent")));
  console.log(c("gray", "  PvP Mode | Smart Tactics | Per-Player Commands\n"));
  
  ws = new WebSocket(WS_URL);
  
  ws.on("open", () => {
    reconnectDelay = 3000;
    console.log(`${tag("WS","green")} 🔌 Connected to game server, authenticating...`);
    send({ type: "AGENT_AUTH", apiKey: API_KEY });
  });
  
  ws.on("message", (data) => {
    onMessage(data.toString()).catch(e => console.error(tag("ERROR","red"), e.message));
  });
  
  ws.on("close", (code) => {
    inMatch = false;
    console.log(`${tag("WS","yellow")} 🔌 Disconnected (code: ${code}), reconnecting in ${reconnectDelay/1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  });
  
  ws.on("error", (err) => {
    console.log(`${tag("WS","red")} ❌ ${err.message}`);
  });
};

// ── Reload config when file changes ──────────────────────────────────────────
const watchConfig = () => {
  setInterval(() => {
    try {
      if (existsSync("./config.json")) {
        const config = JSON.parse(readFileSync("./config.json", "utf8"));
        if (config.apiKey !== API_KEY || config.agentName !== AGENT_NAME || config.strategy !== userStrategy) {
          console.log(`${tag("CONFIG","yellow")} 🔄 Configuration changed, reloading...`);
          API_KEY = config.apiKey;
          AGENT_NAME = config.agentName;
          userStrategy = config.strategy || "balanced";
          userTactics = config.tactics || {};
          
          // Update tactical settings from config
          if (userTactics.pressing) tactical.pressing = parseFloat(userTactics.pressing);
          if (userTactics.tempo) tactical.tempo = parseFloat(userTactics.tempo);
          if (userTactics.width) tactical.width = parseFloat(userTactics.width);
          
          // Reconnect with new config
          if (ws) {
            ws.close();
          }
          setTimeout(connect, 2000);
        }
      }
    } catch (e) {
      // Config file might be locked, ignore
    }
  }, 5000);
};

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log(bold(c("green", "🚀 Starting AI Club League Agent...")));
console.log(c("gray", `📋 Agent Name: ${AGENT_NAME}`));
console.log(c("gray", `🎯 Strategy: ${userStrategy}`));
console.log(c("gray", `🔑 API Key: ${API_KEY.substring(0, 10)}...`));

watchConfig();
connect();
