import 'dotenv/config';
import Redis from 'ioredis';

// Initialize Redis client (same config as server)
const RedisConstructor = Redis;
const redis = process.env.REDIS_URL
  ? new RedisConstructor(process.env.REDIS_URL)
  : new RedisConstructor({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    });

async function listAllUsers() {
  try {
    console.log('Fetching all registered users...\n');
    
    // Get all user keys
    const keys = await redis.keys('user:*');
    
    if (keys.length === 0) {
      console.log('No registered users found.');
      return;
    }
    
    console.log(`Found ${keys.length} registered user(s):\n`);
    
    // Fetch and display each user
    for (const key of keys) {
      const userData = await redis.get(key);
      if (userData) {
        try {
          const user = JSON.parse(userData);
          console.log(`Phone Number: ${user.phoneNumber}`);
          console.log(`User ID: ${user.id}`);
          console.log(`Has Push Token: ${user.pushToken ? 'Yes' : 'No'}`);
          console.log('---');
        } catch (parseError) {
          console.error(`Error parsing data for key ${key}:`, parseError);
        }
      }
    }
    
    // Summary
    console.log(`\nTotal: ${keys.length} user(s)`);
  } catch (error) {
    if (error.message?.includes('ECONNREFUSED') || error.message?.includes('max retries')) {
      console.error('❌ Error: Could not connect to Redis.');
      console.error('Make sure Redis is running on localhost:6379 (or set REDIS_HOST/REDIS_PORT in .env)');
    } else {
      console.error('Error fetching users:', error.message || error);
    }
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

listAllUsers();
