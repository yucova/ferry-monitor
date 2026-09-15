'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');

// ============================================================
// 監視条件（楽天トラベル）
// ============================================================
const CONFIG = {
  // 検索条件はこのURLにすべて入っています（9/22〜23・大人1・幼児(布団食事なし)1・部屋1）
  url: 'https://hotel.travel.rakuten.co.jp/hotelinfo/plan/?f_no=196619&f_teikei=quick&f_flg=PLAN'
     + '&f_otona_su=1&f_s1=0&f_s2=0&f_y1=0&f_y2=0&f_y3=0&f_y4=1&f_kin=&f_kin2=&f_heya_su=1'
     + '&f_nen1=2026&f_tuki1=9&f_hi1=22&f_nen2=2026&f_tuki2=9&f_hi2=23'
     + '&f_hak=&f_tel=&f_target_flg=&f_tscm_flg=&f_p_no=&f_custom_code=&f_search_type='
     + '&f_service=&f_campaign=&f_camp_id=&f_static=1&f_squeezes=breakfast&f_squeezes=dinner',

  checkin: { y: 2026, m: 9, d: 22 },   // この日を過ぎたら自動スキップ

  // 対象プラン（ページ上の <li id="6303280" class="planThumb">）
  planId: '6303280',
  planKeyword: '料理長こだわりの逸品',

  // 狙う部屋（希望順）。code はページ内の部屋コードで、名前の似た部屋と取り違えないため
  // ※「和室12.5畳《バス付》(wa125ba)」は対象外。第7希望は「+広縁」の wa125bau
  rooms: [
    { rank: 1, code: 'way15bau',  name: '和洋室15畳《半露天風呂付》' },
    { rank: 2, code: 'way125bau', name: '和洋室12.5畳《半露天風呂付》' },
    { rank: 3, code: 'wa10bau',   name: '和室10畳《半露天風呂付》' },
    { rank: 4, code: 'wa15ub2',   name: '和室15畳《2点式ユニットバス》' },
    { rank: 5, code: 'wa125ub2',  name: '和室12.5畳《2点式ユニットバス》' },
    { rank: 6, code: 'wa10ub2',   name: '和室10畳+応接間《2点式ユニットバス》' },
    { rank: 7, code: 'wa125bau',  name: '和室12.5畳+広縁《バス付》' },
    { rank: 8, code: 'wa10ba',    name: '和室10畳《バス付》' },
  ],

  // --- 通知の間引き（空室が出た瞬間は即通知。続いているあいだの再通知間隔）---
  remindMinutesSlack: 30,
  remindMinutesLine:  60,

  // --- 静音時間（日本時間）。この間はLINEを鳴らさない ---
  quietFromJST: 1,
  quietToJST:   5,
};

const STATE_FILE = 'state/rakuten.json';

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const LINE_TOKEN    = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID  = process.env.LINE_USER_ID;
const TEST_NOTIFY   = process.env.TEST_NOTIFY === 'true';

// ============================================================
// 小道具
// ============================================================
function fmtDate(t) {
  return t.y + '/' + String(t.m).padStart(2, '0') + '/' + String(t.d).padStart(2, '0');
}

function ymdNum(t) {
  return t.y * 10000 + t.m * 100 + t.d;
}

function yen(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
}

function nowJST() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
}

function todayJST() {
  const j = nowJST();
  return { y: j.getFullYear(), m: j.getMonth() + 1, d: j.getDate() };
}

function isQuietJST() {
  const h = nowJST().getHours();
  const a = CONFIG.quietFromJST;
  const b = CONFIG.quietToJST;
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);
}

function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    console.log('前回の状態を読み込みました（' + Object.keys(st).length + '件）');
    return st;
  } catch (e) {
    console.log('前回の状態はありません（初回、またはキャッシュ切れ）');
    return null;
  }
}

function saveState(st) {
  try {
    fs.mkdirSync('state', { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
    console.log('今回の状態を保存しました（' + Object.keys(st).length + '件）');
  } catch (e) {
    console.log('状態の保存に失敗: ' + e.message);
  }
}

async function saveDebug(page, tag) {
  try {
    fs.mkdirSync('debug', { recursive: true });
    fs.writeFileSync('debug/' + tag + '.html', await page.content());
    await page.screenshot({ path: 'debug/' + tag + '.png', fullPage: false });
    console.log('  debug/' + tag + '.html と .png を保存しました');
  } catch (e) {
    console.log('  デバッグ保存に失敗: ' + e.message);
  }
}

// ============================================================
// 通知
// ============================================================
async function sendSlack(message) {
  if (!SLACK_WEBHOOK) { console.log('  Slack: 未設定'); return false; }
  try {
    const res = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + body);
    console.log('  OK Slack 送信成功');
    return true;
  } catch (e) {
    console.error('  Slack 送信エラー: ' + e.message);
    return false;
  }
}

async function sendLine(message) {
  if (!LINE_TOKEN || !LINE_USER_ID) { console.log('  LINE: 未設定'); return false; }
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LINE_TOKEN,
      },
      body: JSON.stringify({
        to: LINE_USER_ID,
        messages: [{ type: 'text', text: message.slice(0, 4900) }],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + body);
    console.log('  OK LINE 送信成功');
    return true;
  } catch (e) {
    console.error('  LINE 送信エラー: ' + e.message);
    return false;
  }
}

function buildMessage(lines) {
  return '【楽天トラベル 空室発生】\n'
    + 'チェックイン: ' + fmtDate(CONFIG.checkin) + '（1泊・大人1/幼児1）\n'
    + 'プラン: ' + CONFIG.planKeyword + '（2食付）\n\n'
    + lines.join('\n') + '\n\n'
    + '▼すぐ予約\n' + CONFIG.url;
}

// ============================================================
async function run() {
  const label = fmtDate(CONFIG.checkin);
  const quiet = isQuietJST();
  const j = nowJST();
  console.log('=== 楽天トラベル空室監視 [' + label + ' チェックイン] ===');
  console.log('日本時間 ' + fmtDate({ y: j.getFullYear(), m: j.getMonth() + 1, d: j.getDate() }) + ' '
    + String(j.getHours()).padStart(2, '0') + ':' + String(j.getMinutes()).padStart(2, '0')
    + (quiet ? '（静音時間帯：LINEは鳴らしません）' : ''));

  if (TEST_NOTIFY) {
    console.log('*** TEST_NOTIFY=true のため、通知テストのみ実行します ***');
    const msg = '【テスト送信】楽天トラベル空室監視\n'
      + 'この文面が届いていれば、楽天側の監視も通知できる状態です。\n'
      + 'チェックイン: ' + label + ' / 対象 ' + CONFIG.rooms.length + '部屋';
    const a = await sendSlack(msg);
    const b = await sendLine(msg);
    if (!a && !b) process.exitCode = 1;
    return;
  }

  if (ymdNum(CONFIG.checkin) < ymdNum(todayJST())) {
    console.log('> チェックイン日を過ぎているのでスキップします。ワークフローを止めて構いません。');
    return;
  }

  const prev = loadState();
  const next = {};
  const now = Date.now();

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=ja-JP'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1600 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja,en;q=0.8' });

  // 画像・動画・フォントは読まない（ページが約3MBと重いため）
  await page.setRequestInterception(true);
  page.on('request', function (req) {
    const type = req.resourceType();
    if (type === 'image' || type === 'media' || type === 'font') req.abort();
    else req.continue();
  });

  let failed = false;

  try {
    console.log('1. ページを開きます');
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('li.planThumb', { timeout: 30000 });

    const data = await page.evaluate(function (cfg) {
      const out = { plans: [], planFound: false, planTitle: '', rooms: [] };

      const planLis = document.querySelectorAll('li.planThumb');
      for (let i = 0; i < planLis.length; i++) {
        const h = planLis[i].querySelector('h4');
        out.plans.push(planLis[i].id + ': ' + (h ? h.textContent.replace(/\s+/g, ' ').trim() : ''));
      }

      const plan = document.getElementById(cfg.planId);
      if (!plan) return out;
      out.planFound = true;
      const h4 = plan.querySelector('h4');
      out.planTitle = h4 ? h4.textContent.replace(/\s+/g, ' ').trim() : '';

      for (let i = 0; i < cfg.rooms.length; i++) {
        const r = cfg.rooms[i];
        const li = document.getElementById(cfg.planId + '-' + r.code);
        if (!li) {
          out.rooms.push({ code: r.code, exists: false });
          continue;
        }
        const t = li.querySelector('a.media-thumbnail[title]');
        const price = li.querySelector('input[id^="totalPrice-"]');
        const left = li.querySelector('.cmn_numVacantRooms');
        out.rooms.push({
          code: r.code,
          exists: true,
          title: t ? t.getAttribute('title') : '',
          noVacancy: !!li.querySelector('.no-vacancy__message'),
          canReserve: !!li.querySelector('a.yoyakulLink'),
          price: price ? Number(price.value) || 0 : 0,
          left: left ? left.textContent.replace(/\s+/g, '').trim() : '',
        });
      }
      return out;
    }, { planId: CONFIG.planId, rooms: CONFIG.rooms });

    if (!data.planFound) {
      console.log('  !! 対象プラン(' + CONFIG.planId + ')がページにありません');
      console.log('     表示中のプラン: ' + JSON.stringify(data.plans));
      if (data.plans.length > 0) {
        // 他のプランは出ている＝このプランが全室埋まって一覧から消えた可能性が高い
        console.log('> このプランは現在表示されていません（全室満室の可能性）。監視を継続します。');
        for (let i = 0; i < CONFIG.rooms.length; i++) {
          next[CONFIG.rooms[i].code] = { open: false, lastSlack: 0, lastLine: 0 };
        }
        return;
      }
      throw new Error('プラン一覧が読めません');
    }

    if (data.planTitle.indexOf(CONFIG.planKeyword) === -1) {
      console.log('  !! プラン名が想定と違います: ' + data.planTitle);
    }
    console.log('2. プラン確認: ' + data.planTitle);

    const slackLines = [];
    const lineLines = [];
    let openCount = 0;
    let missing = 0;

    for (let i = 0; i < CONFIG.rooms.length; i++) {
      const cfgRoom = CONFIG.rooms[i];
      const r = data.rooms[i];
      const head = '  【第' + cfgRoom.rank + '希望】' + cfgRoom.name;

      if (!r.exists) {
        missing++;
        console.log(head + ' -> ページに部屋コード ' + cfgRoom.code + ' がありません');
        next[cfgRoom.code] = prev && prev[cfgRoom.code] ? prev[cfgRoom.code] : { open: false, lastSlack: 0, lastLine: 0 };
        continue;
      }
      if (r.title && r.title !== cfgRoom.name) {
        console.log('     !! 部屋名がページ上では「' + r.title + '」になっています');
      }

      const open = r.canReserve && !r.noVacancy;
      console.log(head + ' -> ' + (open
        ? '★空室あり ' + (r.price ? yen(r.price) : '') + (r.left ? ' ' + r.left : '')
        : '空室なし'));

      const key = cfgRoom.code;
      const was = prev ? prev[key] : null;

      if (!open) {
        next[key] = { open: false, lastSlack: 0, lastLine: 0 };
        continue;
      }

      openCount++;
      const fresh = !was || !was.open;
      const text = '【第' + cfgRoom.rank + '希望】' + cfgRoom.name
        + (r.price ? '　合計' + yen(r.price) : '')
        + (r.left ? '（' + r.left + '）' : '');

      const slackDue = fresh || (now - (was.lastSlack || 0)) >= CONFIG.remindMinutesSlack * 60000;
      const lineDue  = (fresh || (now - (was.lastLine || 0)) >= CONFIG.remindMinutesLine * 60000) && !quiet;

      if (slackDue) slackLines.push(text);
      if (lineDue)  lineLines.push(text);

      next[key] = {
        open: true,
        lastSlack: slackDue ? now : ((was && was.lastSlack) || now),
        lastLine:  lineDue  ? now : ((was && was.lastLine)  || 0),
      };
    }

    if (missing === CONFIG.rooms.length) {
      await saveDebug(page, 'rakuten-no-rooms');
      throw new Error('対象の部屋が1つも見つかりません（ページ構造が変わった可能性）');
    }

    console.log('');
    if (slackLines.length) await sendSlack(buildMessage(slackLines));
    if (lineLines.length)  await sendLine(buildMessage(lineLines));

    if (!slackLines.length && !lineLines.length) {
      if (openCount > 0) {
        console.log('> 空室は続いていますが、通知済みのため今回は送りません'
          + (quiet ? '（静音時間帯。明けたらLINEも鳴らします）' : ''));
      } else {
        console.log('> 希望' + CONFIG.rooms.length + '部屋に空きなし。監視を継続します。');
      }
    }
  } catch (e) {
    failed = true;
    console.error('!! エラー: ' + e.message);
    await saveDebug(page, 'rakuten-error');
    // 失敗時は前回の状態を持ち越す（取りこぼし・二重通知を防ぐ）
    if (prev) {
      const keys = Object.keys(prev);
      for (let i = 0; i < keys.length; i++) {
        if (!next[keys[i]]) next[keys[i]] = prev[keys[i]];
      }
    }
  } finally {
    await browser.close();
    saveState(next);
    console.log('=== 終了' + (failed ? '（失敗）' : '') + ' ===');
  }

  if (failed) process.exitCode = 1;
}

run();
