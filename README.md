# Purple Box - Secure Messaging System

A privacy-focused messaging application with ephemeral message storage and end-to-end encryption.

## Project Structure

```
box/
├── client/              # Expo React Native client app
├── server/              # Fastify + Socket.io server with Redis
│   └── src/            # Server source files
└── .cursorrules        # Project rules and constraints
```

## Core Principles

1. **NO PERSISTENCE:** Messages are NEVER saved to local storage or server disk
2. **RAM ONLY:** Message state exists only in React State / Zustand / Node variables
3. **LIFECYCLE:** Data is wiped immediately on AppState change (background/close)
4. **PRIVACY:** Screenshots are blocked using `expo-screen-capture`
5. **CRYPTO:** All encryption uses `tweetnacl`. Keys may be stored in `expo-secure-store`, but MESSAGES are strictly RAM-only

## Tech Stack

### Client
- **Framework:** Expo (TypeScript)
- **State Management:** Zustand (volatile message store)
- **Security:** expo-screen-capture, expo-secure-store, expo-notifications
- **Crypto:** tweetnacl, tweetnacl-util
- **Real-time:** socket.io-client

### Server
- **Framework:** Node.js, Fastify
- **Real-time:** Socket.io with Redis adapter
- **Storage:** Redis (Ephemeral mode, 60s TTL on all keys)
- **Crypto:** Handles encrypted payloads (no decryption on server)

## Getting Started

### Server Setup

1. Navigate to the server directory:
```bash
cd server
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the `server/` directory. You can copy from `env.template`:
```bash
cp env.template .env
```

Or manually create it using this template:
```bash
# Create .env file
cat > .env << EOF
# Server Configuration
PORT=3000
HOST=0.0.0.0

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

# CORS Configuration
CORS_ORIGIN=*
EOF
```

Or manually create `server/.env` with the following content:
```
PORT=3000
HOST=0.0.0.0
REDIS_HOST=localhost
REDIS_PORT=6379
CORS_ORIGIN=*
```

4. Start Redis (if not already running):

**Option A: Using Docker (Recommended)**
```bash
# Install Docker Desktop for Windows first: https://www.docker.com/products/docker-desktop/
docker run -d -p 6379:6379 redis:latest
```

**Option B: Install Redis on Windows**
- Download Redis for Windows: https://github.com/microsoftarchive/redis/releases
- Or use WSL2: `wsl sudo apt-get install redis-server && redis-server`
- Or use a cloud Redis service (Redis Cloud, Upstash, etc.)

5. Start the server:
```bash
npm start
```

### Client Setup

1. Navigate to the client directory:
```bash
cd client
```

2. Install dependencies:
```bash
npm install
```

3. Start the Expo development server:
```bash
npm start
```

## Server API

### Socket.io Events

#### Client → Server

- **`join`**: Join a user room
  ```typescript
  socket.emit('join', username: string)
  ```

- **`message`**: Send an encrypted message
  ```typescript
  socket.emit('message', {
    recipient: string,
    encryptedPayload: string
  })
  ```

#### Server → Client

- **`box_full`**: Notification that a message has been received
  ```typescript
  socket.on('box_full', () => {
    // Handle notification
  })
  ```

- **`message:ack`**: Acknowledgment of message receipt
  ```typescript
  socket.on('message:ack', ({ status, error? }) => {
    // Handle acknowledgment
  })
  ```

### HTTP Endpoints

- **`GET /health`**: Health check endpoint
  ```json
  {
    "status": "ok",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
  ```

## Message Flow

1. Client encrypts message using `tweetnacl`
2. Client sends encrypted payload to server via Socket.io
3. Server stores encrypted payload in Redis with 60s TTL
4. Server emits `box_full` event to recipient
5. Recipient retrieves message from Redis (still encrypted)
6. Recipient decrypts message client-side
7. Message is stored only in RAM (Zustand store)
8. On app background/close, all messages are wiped

## Security Features

- **No Server-Side Decryption:** Server never sees plaintext messages
- **Ephemeral Storage:** All Redis keys expire after 60 seconds
- **No Persistence:** Messages never written to disk
- **Screenshot Protection:** Blocked via expo-screen-capture
- **Secure Key Storage:** Encryption keys stored in expo-secure-store

## Development

### Server Development

```bash
cd server
npm run dev
```

### Client Development

```bash
cd client
npm start
```

## Environment Variables

### Server (.env)

Create a `.env` file in the `server/` directory with the following variables:

```env
# Server Configuration
PORT=3000
HOST=0.0.0.0

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

# CORS Configuration
CORS_ORIGIN=*
```

**Variable Descriptions:**
- `PORT`: Server port (default: 3000)
- `HOST`: Server host (default: 0.0.0.0)
- `REDIS_HOST`: Redis host (default: localhost)
- `REDIS_PORT`: Redis port (default: 6379)
- `CORS_ORIGIN`: CORS origin (default: *)

## License

ISC
