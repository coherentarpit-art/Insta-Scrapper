const { MongoClient } = require('mongodb');

const mongoUri = 'mongodb://localhost:27017'; // Replace with your MongoDB connection string
const client = new MongoClient(mongoUri);

async function testConnection() {
  try {
    console.log('Connecting to MongoDB...');
    await client.connect();
    console.log('Connected to MongoDB successfully!');

    const db = client.db('test'); // Test database
    const collection = db.collection('testCollection');

    // Insert a test document
    const result = await collection.insertOne({ test: 'connection' });
    console.log('Test document inserted:', result.insertedId);

    // Clean up
    await collection.deleteOne({ _id: result.insertedId });
    console.log('Test document removed.');
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
  } finally {
    await client.close();
    console.log('MongoDB connection closed.');
  }
}

testConnection();