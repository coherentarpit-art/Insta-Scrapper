require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || 'coherent2026_db';
const prof = process.env.MONGO_COLLECTION || 'insta_Profiles';

(async () => {
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const usernames = await db.collection('insta_QueuedExports').distinct('username', {
    username: { $exists: true, $nin: ['', null] },
  });
  const inProf = await db.collection(prof).distinct('data.username', {});
  const set = new Set(inProf.map((u) => String(u).toLowerCase()));
  let missing = 0;
  for (const u of usernames) {
    if (u && !set.has(String(u).toLowerCase())) missing++;
  }
  console.log('insta_Profiles (full scraped):     ', inProf.length);
  console.log('insta_QueuedExports (usernames):  ', usernames.length);
  console.log('Queued NOT yet in insta_Profiles: ', missing);
  await mongoose.disconnect();
})();
