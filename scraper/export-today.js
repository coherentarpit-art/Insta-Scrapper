/**
 * Export all profiles scraped TODAY from MongoDB to:
 *   1. backend/today_scraped.json  — for manual verification
 *   2. backend/mongo_export.json   — full MongoDB dump for today
 *
 * Usage:  node export-today.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const MONGO_URI  = process.env.MONGO_URI;
const MONGO_DB   = process.env.MONGO_DB   || 'coherent2026_db';
const MONGO_COLL = process.env.MONGO_COLLECTION || 'insta_Profiles';

if (!MONGO_URI) { console.error('MONGO_URI not set in .env'); process.exit(1); }

const schema = new mongoose.Schema({}, { strict: false });
const Profile = mongoose.model('Profile', schema, MONGO_COLL);

async function run() {
  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });
  console.log('Connected to MongoDB');

  // Today's date window
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const todayStr = now.toISOString().slice(0, 10);

  const docs = await Profile.find({
    createdAt: { $gte: start, $lte: end }
  }).lean();

  console.log(`Found ${docs.length} profiles scraped today (${todayStr})`);

  // ── today_scraped.json ──────────────────────────────────────────────────────
  const todayFile = path.join(__dirname, '..', 'backend', 'today_scraped.json');
  const todayData = docs.map(doc => ({
    _exportDate:        todayStr,
    username:           doc.data?.username,
    full_name:          doc.data?.full_name,
    pk:                 doc.data?.pk,
    followers:          doc.data?.followers,
    following:          doc.data?.following,
    our_category:       doc.data?.our_category || doc.crawl_info?.our_category,
    scraped_at:         doc.scraped_at || doc.createdAt,
    crawl_info:         doc.crawl_info,
    data:               doc.data,
    engagement_metrics: doc.engagement_metrics,
    post_types:         doc.data?.post_types,
    recent_posts:       doc.recent_posts,
  }));

  fs.writeFileSync(todayFile, JSON.stringify(todayData, null, 2), 'utf8');
  console.log(`Written → backend/today_scraped.json  (${todayData.length} profiles)`);

  // ── mongo_export.json ───────────────────────────────────────────────────────
  const mongoFile = path.join(__dirname, '..', 'backend', 'mongo_export.json');
  fs.writeFileSync(mongoFile, JSON.stringify(docs, null, 2), 'utf8');
  console.log(`Written → backend/mongo_export.json   (raw MongoDB docs, ${docs.length} records)`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
