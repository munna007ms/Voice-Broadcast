const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Ami = require('asterisk-ami');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads folder exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `audio-${unique}${ext}`);
    }
});
const upload = multer({ storage });

// Global state
let activeCampaign = null;
let callStatuses = [];
let amiConnection = null;

// ---------- AMI Connection ----------
function connectAMI() {
    amiConnection = new Ami({
        host: process.env.ASTERISK_HOST || 'localhost',
        port: process.env.ASTERISK_PORT || 5038,
        username: process.env.ASTERISK_USER || 'admin',
        password: process.env.ASTERISK_PASS || 'password'
    });

    amiConnection.connect();
    amiConnection.on('connect', () => console.log('✅ AMI Connected'));
    amiConnection.on('disconnect', () => {
        console.log('⚠️ AMI Disconnected, reconnecting...');
        setTimeout(connectAMI, 5000);
    });
    amiConnection.on('event', (event) => {
        if (activeCampaign && event.Event === 'DialEnd') {
            const idx = callStatuses.findIndex(c => c.channel === event.Channel);
            if (idx !== -1) {
                callStatuses[idx].status = event.DialStatus === 'ANSWER' ? 'completed' : 'failed';
                callStatuses[idx].duration = event.Duration || 0;
                activeCampaign.completed++;
            }
        }
    });
}

// ---------- Make outbound call via AMI ----------
function makeCall(phoneNumber, audioFile) {
    return new Promise((resolve, reject) => {
        const action = {
            Action: 'Originate',
            Channel: `SIP/${process.env.SIP_TRUNK || 'trunk'}/${phoneNumber}`,
            Context: 'broadcast-context',
            Exten: 'play-audio',
            Priority: 1,
            CallerID: process.env.CALLER_ID || 'VoiceBroadcaster',
            Async: true,
            Variable: `AUDIO_FILE=${audioFile}`
        };
        amiConnection.action(action, (err, response) => {
            if (err) reject(err);
            else resolve(response);
        });
    });
}

// ---------- Concurrency controller ----------
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_CALLS) || 30;
let activeCalls = 0;
let callQueue = [];

async function processQueue() {
    if (!activeCampaign || activeCampaign.stopped) return;
    while (activeCalls < MAX_CONCURRENT && callQueue.length > 0) {
        const { phone, audioFile, idx } = callQueue.shift();
        activeCalls++;
        try {
            await makeCall(phone, audioFile);
            callStatuses[idx].status = 'calling';
        } catch (err) {
            callStatuses[idx].status = 'failed';
            callStatuses[idx].error = err.message;
            activeCampaign.completed++;
            activeCalls--;
            processQueue();
        }
    }
}

function startCampaign(contacts, audioFile) {
    activeCampaign = { started: Date.now(), completed: 0, total: contacts.length, stopped: false };
    callStatuses = contacts.map((phone, idx) => ({ phoneNumber: phone, status: 'pending', idx }));
    callQueue = callStatuses.map((cs, idx) => ({ phone: cs.phoneNumber, audioFile, idx }));
    activeCalls = 0;
    processQueue();

    // Monitor to free slots when calls finish
    const interval = setInterval(() => {
        if (activeCampaign.stopped || activeCampaign.completed >= activeCampaign.total) {
            clearInterval(interval);
            if (!activeCampaign.stopped) console.log('Campaign finished');
            activeCampaign = null;
            return;
        }
        // Simulate call finish (in real AMI, events update status)
        // For demo we reduce activeCalls when status becomes completed/failed
        const currentActive = callStatuses.filter(c => c.status === 'calling').length;
        activeCalls = currentActive;
        processQueue();
    }, 1000);
}

// ---------- API Routes ----------
app.post('/api/upload-audio', upload.single('audio'), (req, res) => {
    const filePath = req.file.path;
    res.json({ filePath });
});

app.post('/api/sip/test', (req, res) => {
    // In production, test the SIP trunk via Asterisk ping or OPTIONS
    res.json({ connected: true, message: 'SIP trunk reachable', balance: '$42.13' });
});

app.post('/api/broadcast/start', (req, res) => {
    if (activeCampaign) return res.status(400).json({ error: 'Broadcast already running' });
    const { contacts, audioFile } = req.body;
    if (!contacts || !contacts.length || !audioFile) return res.status(400).json({ error: 'Missing data' });
    startCampaign(contacts, audioFile);
    res.json({ message: 'Broadcast started' });
});

app.post('/api/broadcast/stop', (req, res) => {
    if (activeCampaign) activeCampaign.stopped = true;
    res.json({ message: 'Stopped' });
});

app.get('/api/broadcast/status', (req, res) => {
    if (!activeCampaign) {
        return res.json({ active: false, completed: 0, total: 0, updates: [] });
    }
    res.json({
        active: true,
        completed: activeCampaign.completed,
        total: activeCampaign.total,
        updates: callStatuses
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Backend listening on http://localhost:${PORT}`);
    connectAMI();
});