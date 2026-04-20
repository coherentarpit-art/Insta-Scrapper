require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI, { dbName: 'coherent2026_db' }).then(async () => {
  const col = mongoose.connection.db.collection('insta_Profiles');
  const profiles = await col.find({ createdAt: { $gte: new Date('2026-04-13') } }).sort({ createdAt: 1 }).toArray();

  profiles.forEach((p, i) => {
    const d = p.data || {};
    const m = d.engagement_metrics || {};
    const posts = d.recent_posts || [];
    const pt = {};
    posts.forEach(x => { pt[x.post_type] = (pt[x.post_type] || 0) + 1; });

    console.log('');
    console.log('────────────────────────────────────────────────────────');
    console.log((i+1) + '. @' + d.username);
    console.log('   Instagram  : https://www.instagram.com/' + d.username + '/');
    console.log('   Category   : ' + (d.our_category || 'unknown'));
    console.log('   Followers  : ' + (d.followers || 0).toLocaleString());
    console.log('   Following  : ' + (d.following || 0).toLocaleString());
    console.log('   Total Posts: ' + (d.posts_count || 0).toLocaleString());
    console.log('   Bio        : ' + (d.bio || '').slice(0, 120));
    console.log('   Website    : ' + (d.external_url || '-'));
    console.log('   Email      : ' + (d.public_email || '-'));
    console.log('   City       : ' + (d.city || '-'));
    console.log('   Business?  : ' + (d.is_business ? 'Yes' : 'No') + '   Professional? ' + (d.is_professional ? 'Yes' : 'No'));
    console.log('   Added at   : ' + new Date(p.createdAt).toISOString());
    console.log('   ── Engagement Metrics ──');
    console.log('   Avg Likes        : ' + m.avg_likes);
    console.log('   Avg Comments     : ' + m.avg_comments);
    console.log('   Avg Views(reels) : ' + m.avg_views);
    console.log('   Avg Engagement   : ' + m.avg_engagement);
    console.log('   Engagement Rate  : ' + m.engagement_rate + '%');
    console.log('   Posts/Week       : ' + m.posts_per_week);
    console.log('   Partnership %    : ' + m.partnership_percentage + '%');
    console.log('   Posts w/Mentions : ' + m.posts_with_mentions);
    console.log('   ── Posts Scraped: ' + posts.length + ' | Breakdown: ' + JSON.stringify(pt));
    posts.forEach((r, j) => {
      console.log(
        '   [' + String(j+1).padStart(2) + '] ' +
        (r.post_type || '?').padEnd(9) +
        ' | views:'    + String(r.views    || 0).padStart(8) +
        ' | likes:'    + String(r.likes    || 0).padStart(7) +
        ' | comments:' + String(r.comments || 0).padStart(5) +
        ' | ' + r.date +
        ' | ' + r.url
      );
    });
  });

  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log('TOTAL scraped today: ' + profiles.length + ' profiles');
  console.log('════════════════════════════════════════════════════════');
  await mongoose.disconnect();
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
