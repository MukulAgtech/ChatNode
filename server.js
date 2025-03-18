// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Create data storage paths
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// Ensure necessary directories exist
[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Initialize messages data
let messages = [];
if (fs.existsSync(MESSAGES_FILE)) {
  try {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading messages file:', err);
  }
}

// Save messages to disk
function saveMessages() {
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving messages:', err);
  }
}

// Set up storage for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // Preserve file extension but use UUID for filename
    const fileExt = path.extname(file.originalname);
    cb(null, uuidv4() + fileExt);
  }
});

const upload = multer({ storage: storage });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get("/git-pull", (req, res) => {
  exec("git pull origin main", (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return res.status(500).send(`Error: ${error.message}`);
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
      return res.status(500).send(`Stderr: ${stderr}`);
    }
    console.log(`Stdout: ${stdout}`);
    res.send(`Git pull successful:\n${stdout}`);
  });
});

// Set up routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API route to get message history
app.get('/api/messages', (req, res) => {
  // Optional: Add pagination for large message history
  const limit = parseInt(req.query.limit) || 50;
  const recentMessages = messages.slice(-limit);
  res.json(recentMessages);
});

// Handle file uploads
app.post('/upload', upload.single('file'), (req, res) => {
  if (req.file) {
    const fileInfo = {
      id: uuidv4(),
      filename: req.file.filename,
      originalname: req.file.originalname,
      path: `/uploads/${req.file.filename}`,
      size: req.file.size,
      mimetype: req.file.mimetype
    };

    // Create a new message for the file
    const fileMessage = {
      id: uuidv4(),
      type: 'file',
      username: req.body.username,
      fileInfo: fileInfo,
      timestamp: new Date().toISOString()
    };

    // Save to message history and notify clients
    messages.push(fileMessage);
    saveMessages();
    io.emit('new-file', fileMessage);
    
    res.json({ success: true, fileInfo });
  } else {
    res.status(400).json({ success: false, message: 'No file uploaded' });
  }
});

// Track connected users
const users = {};

// Socket.io connection handling
io.on('connection', (socket) => {
  let clientIp = socket.request.connection.remoteAddress;

  if (clientIp.startsWith('::ffff:')) { 
    clientIp = clientIp.substring(7); 
  }
  // Handle user joining
  socket.on('user-join', (username) => {
    users[socket.id] = username;
    
    // Create system message for user join
    const joinMessage = {
      id: uuidv4(),
      type: 'system',
      message: `${username} joined the chat (${clientIp})`,
      timestamp: new Date().toISOString()
    };
    
    console.log(`${username} connected from IP: ${clientIp}`);
    messages.push(joinMessage);
    saveMessages();
    
    socket.broadcast.emit('user-joined', username);
    socket.broadcast.emit('system-message', joinMessage);
    
    // Send updated users list to ALL clients
    io.emit('users-list', Object.values(users));
    
    // Send message history to new user
    socket.emit('message-history', messages.slice(-50)); // Send last 50 messages
  });

  // Add this new handler for get-users
  socket.on('get-users', () => {
    socket.emit('users-list', Object.values(users));
  });

  // Handle chat messages
  socket.on('chat-message', (message) => {
    const username = users[socket.id];
    if (!username || !message.trim()) return;
    
    const messageObj = {
      id: uuidv4(),
      type: 'chat',
      username: username,
      message: message,
      timestamp: new Date().toISOString()
    };
    
    messages.push(messageObj);
    saveMessages();
    io.emit('chat-message', messageObj);
  });

  socket.on('typing', () => {
    const username = users[socket.id];
    if (username) {
      socket.broadcast.emit('typing', username);
    }
  });

  socket.on('stop-typing', () => {
    const username = users[socket.id];
    if (username) {
      socket.broadcast.emit('stop typing', username);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const username = users[socket.id];
    if (username) {
      // Create system message for user leaving
      const leaveMessage = {
        id: uuidv4(),
        type: 'system',
        message: `${username} left the chat`,
        timestamp: new Date().toISOString()
      };
      
      messages.push(leaveMessage);
      saveMessages();
      
      socket.broadcast.emit('user-left', username);
      socket.broadcast.emit('system-message', leaveMessage);
      delete users[socket.id];
      
      // Send updated users list to ALL remaining clients
      io.emit('users-list', Object.values(users));
    }
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Your local IP address may look like: ${getLocalIpAddress()}`);
  console.log(`Message history: ${messages.length} messages stored`);
});

// Helper function to get local IP address
function getLocalIpAddress() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip internal and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '192.168.x.x (check your network settings)';
}
