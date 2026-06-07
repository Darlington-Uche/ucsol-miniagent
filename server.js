import express from 'express';
import { createServer } from 'http';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
let agentProcess = null;

app.use(express.json());
app.use(express.static('public'));

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Save configuration and restart agent
app.post('/api/config', (req, res) => {
  const { apiKey, agentName, strategy, pressing, tempo, width } = req.body;
  
  const config = {
    apiKey: apiKey || process.env.API_KEY,
    agentName: agentName || 'MyAgent',
    strategy: strategy || 'balanced',
    tactics: { pressing, tempo, width }
  };
  
  writeFileSync('./config.json', JSON.stringify(config, null, 2));
  
  // Restart agent
  restartAgent();
  
  res.json({ success: true, message: '⚽ Config saved! Agent restarting...' });
});

// Get agent status
app.get('/api/status', (req, res) => {
  const running = agentProcess && !agentProcess.killed;
  const brain = existsSync('./BRAIN.md') ? readFileSync('./BRAIN.md', 'utf8') : '';
  
  res.json({ 
    running,
    pid: agentProcess?.pid,
    brain: brain.substring(0, 500)
  });
});

// Start agent
function startAgent() {
  if (agentProcess && !agentProcess.killed) {
    agentProcess.kill();
  }
  
  console.log('🚀 Starting agent...');
  agentProcess = spawn('node', ['agent.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  });
  
  agentProcess.stdout.on('data', (data) => {
    console.log(`⚽ ${data.toString().trim()}`);
  });
  
  agentProcess.stderr.on('data', (data) => {
    console.error(`❌ ${data.toString().trim()}`);
  });
  
  agentProcess.on('close', (code) => {
    console.log(`🏁 Agent stopped (code: ${code})`);
  });
}

function restartAgent() {
  if (agentProcess && !agentProcess.killed) {
    agentProcess.kill('SIGTERM');
    setTimeout(startAgent, 2000);
  } else {
    startAgent();
  }
}

server.listen(3000, () => {
  console.log('⚽ Dashboard running at http://localhost:3000');
  startAgent();
});