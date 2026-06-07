#!/usr/bin/env node

import WebSocket from "ws";
import http from "http";
import { existsSync, readFileSync, writeFileSync } from "fs";
import crypto from "crypto";

const API_KEY = "";
const WS_URL = "wss://game.agentsleague.net/agent";
const MEMORY_FILE = "./unbeatable_memory.json";

let ws, agentId, matchId, mySide;
let score = { home: 0, away: 0 };
let matchMinute = 0;
let inMatch = false;
let totalMatches = 0;
let totalWins = 0;
let currentStreak = 0;
let maxStreak = 0;
let opponentName = "?";
let reconnectDelay = 3000;
let lastTickSeq = 0;
let currentPressure = 50;
let currentMomentum = 0;

let playerCache = {};
let opponentCache = {};
let memory = {};
let matchHistory = [];

if (existsSync(MEMORY_FILE)) {
  memory = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
}

const saveMemory = () => {
  writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
};

let tacticalState = {
  philosophy: 1.0,
  pressing: 1.0,
  width: 0.85,
  tempo: 0.95,
  lineHeight: 0.15,
  lastUpdate: 0
};

class NeuralPredictor {
  constructor() {
    this.weights = {
      w1: Array(20).fill().map(() => Array(12).fill().map(() => (Math.random() - 0.5) * 0.1)),
      w2: Array(8).fill().map(() => Array(20).fill().map(() => (Math.random() - 0.5) * 0.1)),
      w3: Array(4).fill().map(() => Array(8).fill().map(() => (Math.random() - 0.5) * 0.1))
    };
    this.bias1 = Array(20).fill().map(() => (Math.random() - 0.5) * 0.1);
    this.bias2 = Array(8).fill().map(() => (Math.random() - 0.5) * 0.1);
    this.bias3 = Array(4).fill().map(() => (Math.random() - 0.5) * 0.1);
    this.learningRate = 0.01;
  }

  relu(x) { return Math.max(0, x); }
  sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
  tanh(x) { return Math.tanh(x); }

  forward(input) {
    let hidden1 = Array(20).fill(0);
    for (let i = 0; i < 20; i++) {
      let sum = this.bias1[i];
      for (let j = 0; j < 12; j++) sum += input[j] * this.weights.w1[j][i];
      hidden1[i] = this.relu(sum);
    }
    let hidden2 = Array(8).fill(0);
    for (let i = 0; i < 8; i++) {
      let sum = this.bias2[i];
      for (let j = 0; j < 20; j++) sum += hidden1[j] * this.weights.w2[j][i];
      hidden2[i] = this.tanh(sum);
    }
    let output = Array(4).fill(0);
    for (let i = 0; i < 4; i++) {
      let sum = this.bias3[i];
      for (let j = 0; j < 8; j++) sum += hidden2[j] * this.weights.w3[j][i];
      output[i] = this.sigmoid(sum);
    }
    return output;
  }

  predict(oppPlayers, ball, minute, scoreDiff) {
    const features = [
      ball.x / 800,
      ball.y / 600,
      minute / 90,
      scoreDiff / 5,
      oppPlayers.filter(p => p.x > 400).length / 5,
      oppPlayers.filter(p => p.hasBall).length,
      (oppPlayers.reduce((s, p) => s + (p.attributes?.speed || 50), 0) / 500),
      (oppPlayers.reduce((s, p) => s + (p.attributes?.defending || 50), 0) / 500),
      oppPlayers.filter(p => p.role === "FWD" && p.x > 500).length,
      currentMomentum / 100,
      currentPressure / 100,
      currentStreak / 10
    ];
    const pred = this.forward(features);
    const actions = ["HIGH_PRESS", "COUNTER", "POSSESSION", "PARK_BUS"];
    return { action: actions[pred.indexOf(Math.max(...pred))], confidence: Math.max(...pred), all: pred };
  }

  train(features, target) {
    const pred = this.forward(features);
    const error = target.map((t, i) => t - pred[i]);
    for (let i = 0; i < this.weights.w3.length; i++) {
      for (let j = 0; j < this.weights.w3[i].length; j++) {
        this.weights.w3[i][j] += this.learningRate * error[j] * pred[j] * (1 - pred[j]);
      }
    }
  }
}

class PhysicsEngine {
  constructor() {
    this.g = 9.8;
    this.drag = 0.98;
    this.shootSpeed = 620;
    this.passSpeed = 380;
    this.collectRadius = 25;
    this.gkCollectRadius = 38;
    this.tackleRadius = 30;
  }

  calculateTrajectory(x, y, vx, vy, steps = 20) {
    let points = [];
    let cx = x, cy = y;
    let cvx = vx, cvy = vy;
    for (let i = 0; i < steps; i++) {
      cvx *= this.drag;
      cvy = (cvy - this.g * 0.05) * this.drag;
      cx += cvx * 0.05;
      cy += cvy * 0.05;
      if (cx < 0 || cx > 800 || cy < 0 || cy > 600) break;
      points.push({ x: cx, y: cy, time: i * 0.05 });
    }
    return points;
  }

  predictInterception(passer, target, ball, defenders) {
    const dx = target.x - passer.x;
    const dy = target.y - passer.y;
    const distance = Math.hypot(dx, dy);
    const passTime = distance / this.passSpeed;
    let earliestDefender = null;
    let earliestTime = Infinity;
    for (const def of defenders) {
      const timeToIntercept = Math.hypot(def.x - passer.x, def.y - passer.y) / (def.attributes?.speed || 50) * 1.8;
      if (timeToIntercept < passTime && timeToIntercept < earliestTime) {
        earliestTime = timeToIntercept;
        earliestDefender = def;
      }
    }
    return { willIntercept: earliestDefender !== null, defender: earliestDefender, time: earliestTime };
  }

  calculateShotSuccess(shooter, keeper, distance, angle) {
    const shooterSkill = shooter.attributes?.shooting || 50;
    const keeperSkill = keeper.attributes?.gkPositioning || 50;
    let success = 0.6 * (shooterSkill / 100);
    success *= (1 - (distance - 260) / 500);
    success *= (1 - (keeperSkill / 200));
    const angleFactor = 1 - Math.abs(angle) / 180;
    success *= angleFactor;
    return Math.min(0.95, Math.max(0.05, success));
  }

  calculateOptimalShotTarget(keeperY, shooterY) {
    const topCorner = 240;
    const bottomCorner = 360;
    const center = 300;
    const keeperOffset = Math.abs(keeperY - 300);
    if (keeperOffset > 60) {
      return keeperY < 300 ? topCorner : bottomCorner;
    }
    return shooterY < 300 ? bottomCorner : topCorner;
  }

  calculateTackleSuccess(tackler, carrier) {
    const tacklerDef = tackler.attributes?.defending || 50;
    const carrierDef = carrier.attributes?.defending || 50;
    return tacklerDef / (tacklerDef + carrierDef + 20);
  }
}

class FormationOptimizer {
  constructor() {
    this.positions = {
      attack: {
        GK: { x: 40, y: 300 },
        DEF: [{ x: 200, y: 230 }, { x: 200, y: 370 }],
        MF: [{ x: 400, y: 260 }, { x: 400, y: 340 }],
        FWD: [{ x: 650, y: 300 }]
      },
      ultra: {
        GK: { x: 35, y: 300 },
        DEF: [{ x: 150, y: 250 }, { x: 150, y: 350 }],
        MF: [{ x: 350, y: 280 }, { x: 350, y: 320 }],
        FWD: [{ x: 720, y: 260 }, { x: 720, y: 340 }]
      },
      defend: {
        GK: { x: 50, y: 300 },
        DEF: [{ x: 120, y: 220 }, { x: 120, y: 380 }],
        MF: [{ x: 250, y: 240 }, { x: 250, y: 360 }],
        FWD: [{ x: 400, y: 300 }]
      }
    };
  }

  getPositions(philosophy, ballX, timeLeft, scoreDiff) {
    if (scoreDiff < 0 && timeLeft < 30) return this.positions.ultra;
    if (philosophy > 0.8) return this.positions.attack;
    if (scoreDiff > 1 && timeLeft < 20) return this.positions.defend;
    return this.positions.attack;
  }
}

class DecisionEngine {
  constructor() {
    this.lastCommands = {};
    this.cooldowns = {};
  }

  shouldShoot(player, ballX, keeper, philosophy) {
    const shootRange = 260 * (0.75 + philosophy * 0.5);
    const distanceToGoal = 800 - ballX;
    const inRange = distanceToGoal <= shootRange;
    const hasSpace = Math.abs(player.y - (keeper?.y || 300)) > 40;
    return (inRange && hasSpace) || (distanceToGoal < 200);
  }

  shouldPass(passer, targets, defenders, ballX) {
    const bestTarget = targets.reduce((best, t) => {
      const dist = Math.hypot(t.x - passer.x, t.y - passer.y);
      const isForward = t.x > passer.x;
      let risk = 0;
      for (const d of defenders) {
        const toTarget = Math.hypot(t.x - passer.x, t.y - passer.y);
        const toDefender = Math.hypot(d.x - passer.x, d.y - passer.y);
        if (toDefender < toTarget * 0.7) risk += 0.3;
      }
      const score = (isForward ? 1.5 : 0.5) * (1 - risk) / (dist / 200);
      return score > best.score ? { target: t, score } : best;
    }, { target: null, score: -1 });
    return bestTarget;
  }

  shouldTackle(player, carrier) {
    if (!carrier) return false;
    const distance = Math.hypot(carrier.x - player.x, carrier.y - player.y);
    return distance < 35 && player.canAct !== false;
  }

  getDefensivePosition(defender, ball, threats) {
    const nearestThreat = threats.reduce((a, b) => {
      return Math.hypot(a.x - defender.x, a.y - defender.y) < Math.hypot(b.x - defender.x, b.y - defender.y) ? a : b;
    }, threats[0]);
    if (nearestThreat) {
      return { x: Math.max(100, nearestThreat.x - 50), y: nearestThreat.y };
    }
    return { x: 180, y: defender.y };
  }

  getMidfieldPosition(mid, ball, hasBall) {
    if (hasBall) {
      return { x: Math.min(600, ball.x + 50), y: ball.y };
    }
    return { x: 380, y: ball.y };
  }

  getForwardPosition(fwd, ball, defenders) {
    const gaps = defenders.map(d => d.y).sort((a, b) => a - b);
    let bestGap = 300;
    if (gaps.length >= 2) {
      let largestGap = 0;
      for (let i = 1; i < gaps.length; i++) {
        const gap = gaps[i] - gaps[i-1];
        if (gap > largestGap) {
          largestGap = gap;
          bestGap = (gaps[i] + gaps[i-1]) / 2;
        }
      }
    }
    if (ball.x > 400) {
      return { x: 650, y: bestGap };
    }
    return { x: 550, y: bestGap };
  }
}

const predictor = new NeuralPredictor();
const physics = new PhysicsEngine();
const formations = new FormationOptimizer();
const decisions = new DecisionEngine();

const sendTactical = () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: "AGENT_TACTICAL",
    config: {
      philosophy: tacticalState.philosophy,
      pressing: tacticalState.pressing,
      width: tacticalState.width,
      tempo: tacticalState.tempo,
      lineHeight: tacticalState.lineHeight
    }
  }));
};

const updateTactics = (scoreDiff, timeLeft, ballX, opponentPrediction) => {
  if (scoreDiff < 0 && timeLeft < 30) {
    tacticalState.philosophy = 1.0;
    tacticalState.pressing = 1.0;
    tacticalState.width = 1.0;
    tacticalState.tempo = 1.0;
    tacticalState.lineHeight = 0.1;
  } else if (scoreDiff > 1 && timeLeft < 20) {
    tacticalState.philosophy = 0.3;
    tacticalState.pressing = 0.4;
    tacticalState.width = 0.4;
    tacticalState.tempo = 0.3;
    tacticalState.lineHeight = 0.8;
  } else if (opponentPrediction.action === "HIGH_PRESS" && opponentPrediction.confidence > 0.7) {
    tacticalState.tempo = 0.9;
    tacticalState.width = 0.85;
    tacticalState.philosophy = 0.8;
  } else if (opponentPrediction.action === "PARK_BUS") {
    tacticalState.philosophy = 0.95;
    tacticalState.width = 0.9;
    tacticalState.creativity = 0.9;
  } else {
    tacticalState.philosophy = 0.9;
    tacticalState.pressing = 0.85;
    tacticalState.width = 0.8;
    tacticalState.tempo = 0.85;
    tacticalState.lineHeight = 0.25;
  }
  sendTactical();
};

const generateCommands = (obs) => {
  const commands = [];
  const myPlayers = obs.myPlayers || [];
  const oppPlayers = obs.oppPlayers || [];
  const ball = obs.ball;
  const ballX = ball?.x || 400;
  const ballY = ball?.y || 300;
  const ballCarrier = myPlayers.find(p => p.hasBall);
  const oppCarrier = oppPlayers.find(p => p.hasBall);
  const myGoals = mySide === "home" ? score.home : score.away;
  const oppGoals = mySide === "home" ? score.away : score.home;
  const scoreDiff = myGoals - oppGoals;
  const timeLeft = 90 - matchMinute;
  currentPressure = Math.min(100, Math.abs(scoreDiff) * 20 + (timeLeft < 30 ? 40 : 0));
  currentMomentum = currentMomentum * 0.95 + (ballCarrier ? 5 : -2);
  const opponentPrediction = predictor.predict(oppPlayers, ball, matchMinute, scoreDiff);
  updateTactics(scoreDiff, timeLeft, ballX, opponentPrediction);
  const formationPositions = formations.getPositions(tacticalState.philosophy, ballX, timeLeft, scoreDiff);
  const gk = oppPlayers.find(p => p.role === "GK");
  for (const player of myPlayers) {
    const role = player.role;
    let targetX, targetY;
    let oneShotAction = null;
    if (role === "GK") {
      let targetYpos = Math.min(560, Math.max(40, ballY * 0.6 + 120));
      if (ballX > 550 && !ballCarrier && Math.abs(ballY - player.y) < 100) {
        targetX = Math.min(180, ballX - 30);
        targetY = targetYpos;
      } else {
        targetX = formationPositions.GK.x;
        targetY = targetYpos;
      }
      commands.push({ playerId: player.id, action: { type: "MOVE", targetX, targetY } });
    } else if (role === "DEF") {
      const threats = oppPlayers.filter(p => (p.role === "FWD" || p.role === "MF") && p.x > 300);
      const pos = decisions.getDefensivePosition(player, ball, threats);
      targetX = pos.x;
      targetY = pos.y;
      if (decisions.shouldTackle(player, oppCarrier)) {
        commands.push({ playerId: player.id, action: { type: "TACKLE" } });
      }
      commands.push({ playerId: player.id, action: { type: "MOVE", targetX, targetY } });
    } else if (role === "MF") {
      const pos = decisions.getMidfieldPosition(player, ball, ballCarrier?.id === player.id);
      targetX = pos.x;
      targetY = pos.y;
      if (ballCarrier?.id === player.id && player.canAct !== false) {
        const forwardPlayers = myPlayers.filter(p => p.role === "FWD" && p.x > player.x);
        const passTarget = decisions.shouldPass(player, forwardPlayers, oppPlayers, ballX);
        if (passTarget.target && passTarget.score > 0.5) {
          oneShotAction = { type: "PASS", targetPlayerId: passTarget.target.id };
        } else if (ballX > 500) {
          const shotY = physics.calculateOptimalShotTarget(gk?.y || 300, player.y);
          oneShotAction = { type: "SHOOT_AIMED", targetX: 7540, targetY: shotY };
        }
      }
      commands.push({ playerId: player.id, action: { type: "MOVE", targetX, targetY } });
      if (oneShotAction) commands.push({ playerId: player.id, action: oneShotAction });
    } else if (role === "FWD") {
      const pos = decisions.getForwardPosition(player, ball, oppPlayers.filter(p => p.role === "DEF"));
      targetX = pos.x;
      targetY = pos.y;
      if (ballCarrier?.id === player.id && player.canAct !== false) {
        const shotY = physics.calculateOptimalShotTarget(gk?.y || 300, player.y);
        oneShotAction = { type: "SHOOT_AIMED", targetX: 790, targetY: shotY };
      } else if (!ballCarrier && ballX > 990) {
        const shotY = physics.calculateOptimalShotTarget(gk?.y || 300, ballY);
        oneShotAction = { type: "SHOOT_AIMED", targetX: 790, targetY: shotY };
      }
      commands.push({ playerId: player.id, action: { type: "MOVE", targetX, targetY } });
      if (oneShotAction) commands.push({ playerId: player.id, action: oneShotAction });
    }
  }
  return commands;
};

const send = (obj) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

const sendCommands = (commands, seq) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send({
    type: "AGENT_COMMANDS",
    seq: seq,
    commands: commands,
    meta: { confidence: 0.99 }
  });
};

const startMatch = () => {
  score = { home: 0, away: 0 };
  matchMinute = 0;
  inMatch = true;
  currentMomentum = 0;
  currentPressure = 50;
  tacticalState = {
    philosophy: 70.0, pressing: 1.0, width: 0.85, tempo: 0.95, lineHeight: 0.15, lastUpdate: 0
  };
  send({
    type: "AGENT_FIND_PVP",
    maxRatingGap: 200,
    strategy: "unstoppable"
  });
};

const handleGoal = (ev) => {
  const side = ev.side || ev.team;
  if (side === "home") score.home++;
  else if (side === "away") score.away++;
  const weScored = (side === mySide);
  if (weScored) currentMomentum = Math.min(100, currentMomentum + 20);
  else currentMomentum = Math.max(-100, currentMomentum - 15);
};

const onMessage = async (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case "AGENT_WELCOME":
      agentId = msg.agentId;
      console.log(`\n🔥 UNBEATABLE BOT: ${agentId}`);
      console.log(`📚 Memory: ${Object.keys(memory).length} opponents\n`);
      startMatch();
      break;
    case "AGENT_INIT":
      const ctx = msg.context || {};
      matchId = msg.matchId;
      score = { home: 0, away: 0 };
      matchMinute = 0;
      inMatch = true;
      mySide = ctx.myTeamId || msg.mySide || "away";
      opponentName = ctx.opponentName || msg.opponentName || "?";
      if (memory[opponentName]) {
        const m = memory[opponentName];
        if (m.losses > m.wins) tacticalState.philosophy = 1.0;
      }
      break;
    case "AGENT_OBSERVE":
      if (msg.gameTime) matchMinute = Math.floor(msg.gameTime / 60);
      if (msg.ball && msg.myPlayers) {
        const commands = generateCommands(msg);
        if (commands.length > 0) sendCommands(commands, msg.seq);
      }
      break;
    case "AGENT_EVENT":
      const ev = msg.event || msg;
      if (ev.type === "GOAL") handleGoal(ev);
      break;
    case "AGENT_MATCH_END":
      inMatch = false;
      const r = msg.result || {};
      const finalScore = r.score || {};
      const myG = mySide === "home" ? (finalScore.home ?? score.home) : (finalScore.away ?? score.away);
      const oppG = mySide === "home" ? (finalScore.away ?? score.away) : (finalScore.home ?? score.home);
      const outcome = myG > oppG ? "WIN" : myG < oppG ? "LOSS" : "DRAW";
      totalMatches++;
      if (outcome === "WIN") { totalWins++; currentStreak++; if (currentStreak > maxStreak) maxStreak = currentStreak; }
      else currentStreak = 0;
      if (!memory[opponentName]) memory[opponentName] = { wins: 0, losses: 0, draws: 0, lastPlayed: Date.now() };
      if (outcome === "WIN") memory[opponentName].wins++;
      else if (outcome === "LOSS") memory[opponentName].losses++;
      else memory[opponentName].draws++;
      memory[opponentName].lastPlayed = Date.now();
      saveMemory();
      const winRate = totalMatches ? ((totalWins / totalMatches) * 100).toFixed(1) : 0;
      console.log(`\n📊 ${outcome} ${myG}-${oppG} | WR: ${winRate}% | Streak: ${currentStreak}\n`);
      setTimeout(() => startMatch(), 3000);
      break;
    case "AGENT_ERROR":
      if (msg.code === "NO_ENERGY") setTimeout(() => startMatch(), 60000);
      else setTimeout(() => startMatch(), 5000);
      break;
  }
};

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`UNBEATABLE BOT - ${totalWins}/${totalMatches} wins | ${currentStreak} streak\n`);
}).listen(PORT, () => {});

const connect = () => {
  ws = new WebSocket(WS_URL);
  ws.on("open", () => { reconnectDelay = 3000; send({ type: "AGENT_AUTH", apiKey: API_KEY }); });
  ws.on("message", (data) => { onMessage(data.toString()).catch(e => {}); });
  ws.on("close", () => { setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); });
  ws.on("error", (err) => {});
};

connect();