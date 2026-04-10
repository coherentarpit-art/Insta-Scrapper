require('dotenv').config();

const { MongoClient } = require('mongodb');

const mongoUri = process.env.MONGO_URI;
const mongoDB = process.env.MONGO_DB || 'coherent2026_db';
const mongoCollection = process.env.MONGO_COLLECTION || 'insta_Profiles';

if (!mongoUri) {
  console.error('ERROR: MONGO_URI is not set in .env');
  process.exit(1);
}

const client = new MongoClient(mongoUri);

async function testConnection() {
  try {
    console.log('Connecting to MongoDB...');
    console.log(`  URI : ${mongoUri.replace(/:([^@]+)@/, ':<password>@')}`);
    console.log(`  DB  : ${mongoDB}`);
    console.log(`  Col : ${mongoCollection}`);

    await client.connect();
    console.log('\nConnected to MongoDB Atlas successfully!');

    const db = client.db(mongoDB);

    // Ping the deployment to confirm connection
    await db.command({ ping: 1 });
    console.log('Ping successful — cluster is reachable.');

    const collection = db.collection(mongoCollection);

    // Insert a test document
    const result = await collection.insertOne({
      _test: true,
      note: 'connection test',
      createdAt: new Date(),
    });
    console.log('\nTest document inserted:', result.insertedId);

    // Clean up
    await collection.deleteOne({ _id: result.insertedId });
    console.log('Test document removed.');

    // Count existing documents
    const count = await collection.countDocuments();
    console.log(`\nExisting documents in '${mongoCollection}': ${count}`);

  } catch (error) {
    console.error('\nMongoDB connection failed:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\nMongoDB connection closed.');
  }
}

testConnection();
