import express, { Request, Response } from 'express';
import http from 'http';
import WebSocket from 'ws';
import { Server, Socket } from 'socket.io';
import dotenv from 'dotenv';
import mongoose, { Document, Schema, Model } from 'mongoose';
import jwt, { JwtPayload } from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import cors from 'cors';

dotenv.config();

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Extend Request interface for JWT user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/coinbase';
mongoose
  .connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

// User schema and model
interface IUser extends Document {
  _id: string;
  username: string;
  password: string;
}

const userSchema = new Schema<IUser>( {
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
});

const User: Model<IUser> = mongoose.model('User', userSchema);

// Coinbase data schema
interface ICoinbaseData extends Document {
  product_id: string;
  type: string;
  price: string;
  size: string;
  side: string;
  bids: Array<any>;
  asks: Array<any>;
  time: Date;
}

const coinbaseSchema = new Schema<ICoinbaseData>(
  {
    product_id: String,
    type: String,
    price: String,
    size: String,
    side: String,
    bids: [Schema.Types.Mixed],
    asks: [Schema.Types.Mixed],
    time: Date,
  },
  { timestamps: true }
);

const CoinbaseData: Model<ICoinbaseData> = mongoose.model('CoinbaseData', coinbaseSchema);

// JWT secret key
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Signup endpoint
app.post('/signup', async (req: Request, res: Response): Promise<any> => {
  const { username, password } = req.body;

  // Validate the input
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Check if the user already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: 'Username already taken' });
    }

    // Create and save the new user
    const user = new User({ username, password: hashedPassword });
    await user.save();

    return res.status(201).json({ message: 'User created successfully' });
  } catch (err: any) {
    console.error('Error creating user:', err);
    return res.status(500).json({ message: 'Error creating user', error: err.message });
  }
});

// Login endpoint
app.post('/login', async (req: Request, res: Response): Promise<any> => {
  const { username, password } = req.body;

  try {
    // Validate input
    if (!username || !password) {
      res.status(400).json({ message: 'Username and password are required' });
      return;
    }

    // Check if user exists
    const user = await User.findOne({ username });
    if (!user) {
      res.status(401).json({ message: 'Invalid username or password' });
      return;
    }

    // Validate password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      res.status(401).json({ message: 'Invalid username or password' });
      return;
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id.toString(), username: user.username },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.status(200).json({ token });
  } catch (error: any) {
    console.error('Error during login:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Middleware to verify JWT for WebSocket
const authenticateJWT = (socket: Socket, next: Function) => {
  const token = socket.handshake.auth.token as string;
  if (!token) {
    return next(new Error('Authentication error: Token is required'));
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return next(new Error('Authentication error: Invalid token'));
    }
    socket.data.user = user;
    next();
  });
};

// WebSocket configuration
const COINBASE_WS_URL = 'wss://ws-feed-public.sandbox.exchange.coinbase.com';
const websocketClients: { [key: string]: WebSocket } = {};
const userSubscriptions: { [key: string]: string[] } = {};

// Apply WebSocket middleware
io.use(authenticateJWT);

// WebSocket connection logic
io.on('connection', (socket: Socket) => {
  //console.log(`User connected: ${socket.id}, Username: ${socket.data.user.username}`);

  // Subscribe to a product
  socket.on('subscribe', ({ product_id }: { product_id: string }) => {
    console.log('subscribe'+product_id);

    if (!websocketClients[product_id]) {
      console.log('inside the if subscribe'+websocketClients[product_id]);

      const ws = new WebSocket(COINBASE_WS_URL);
      websocketClients[product_id] = ws;

      ws.on('open', () => {
        console.log(`WebSocket opened for ${product_id}`);

        ws.send(
          JSON.stringify({
            type: 'subscribe',
            product_ids: [product_id],
            channels: ['level2', 'matches'],
          })
        );
      });

      ws.on('message', (data) => {
        //console.log('message from server'+product_id);
        const parsedData = JSON.parse(data.toString());
        //console.log(parsedData) ;
        if (!parsedData.product_id)
          {
            // console.log(' true ') ;
             return;
          } 

        io.to(product_id).emit('data', parsedData);

        if (['l2update', 'match'].includes(parsedData.type)) {
          new CoinbaseData({ ...parsedData }).save().catch(console.error);
        }
      });

      ws.on('close', () => delete websocketClients[product_id]);
    }

    socket.join(product_id);
    userSubscriptions[socket.id] = userSubscriptions[socket.id] || [];
    userSubscriptions[socket.id].push(product_id);
    socket.emit('subscribed', product_id);
  });

  // Unsubscribe from a product
// Unsubscribe from a product
// Server-side
socket.on('unsubscribe', ({ product_id }) => {
  console.log(`Unsubscribed from ${product_id}`);

  // Remove the socket from the room (product)
  socket.leave(product_id);

  // Optionally: Update subscription status for the user
  if (userSubscriptions[socket.id]) {
    console.log(`removed from ${userSubscriptions[socket.id]}`);

    // Remove the product_id from the user's subscriptions
    userSubscriptions[socket.id] = userSubscriptions[socket.id].filter((id) => id !== product_id);
  }

  // Check if there are any active subscribers left for this product
  const room = io.sockets.adapter.rooms.get(product_id);
  if (room && room.size === 0) {
    // If no subscribers are left for the product, close its WebSocket connection
    console.log(`No active subscribers for ${product_id}, closing WebSocket connection.`);
    const ws = websocketClients[product_id];
    if (ws) {
      ws.close(); // Close WebSocket connection
      delete websocketClients[product_id]; // Remove the reference from the tracking object
    }
  }

  console.log('product_id: ' + product_id);

  // Emit the 'unsubscribed' event to the client with acknowledgment handling
  socket.emit('unsubscribed', product_id, (ack:any) => {
    // **CHANGE:** Check if the acknowledgment callback exists
    console.log('product_id: ==========');

    if (typeof ack === 'function') {
      // **CHANGE:** Log acknowledgment result
      if (ack.success) {
        console.log('Unsubscription successful');
      } else {
        console.error('Unsubscription failed');
      }
    } else {
      // **NEW:** Log an error if the client did not provide an acknowledgment callback
      console.error('No acknowledgment provided by the client.');
    }
  });

  

});



socket.on('disconnect', (reason:any) => {
  console.log(`Socket disconnected: ${reason}`);

  if (userSubscriptions[socket.id]) {
    userSubscriptions[socket.id].forEach((product_id) => {
      socket.leave(product_id);

      // Check if there are no more subscribers for this product
      const room = io.sockets.adapter.rooms.get(product_id);
      if (!room || room.size === 0) {
        console.log(`No active subscribers for ${product_id}, closing WebSocket connection.`);
        const ws = websocketClients[product_id];
        if (ws) {
          ws.close();
          delete websocketClients[product_id];
        }
      }
    });

    // Remove user's subscriptions from tracking
    delete userSubscriptions[socket.id];
  }
});

setInterval(() => {
  const activeWebSocketConnections = Object.keys(websocketClients).length;
  const activeSubscriptions = Object.values(userSubscriptions).reduce(
    (acc, subs) => acc + subs.length,
    0
  );

  let status = 'System is running smoothly';

  if (activeWebSocketConnections === 0) {
    status = 'No active WebSocket connections';
  } else if (activeSubscriptions === 0) {
    status = 'No active product subscriptions';
  } else {
    status = `Active WebSocket connections: ${activeWebSocketConnections}, Active subscriptions: ${activeSubscriptions}`;
  }

  io.emit('system_status', status); // Send dynamic status to all connected clients
}, 5000);




});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
