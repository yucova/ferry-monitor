'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');

// ============================================================
// 監視条件
// ============================================================
// 区間コード: 11=神戸→大分 / 12=大分→神戸 / 21=大阪1→別府 / 22=別府→大阪1
//             31=大阪2→志布志 / 32=志布志→大阪2
// 等級名は「空白を除いたページ上の表記」と完全一致させること。
// ※「プライベート ｼﾝｸﾞﾙ ﾂｲﾝ」はページ上が半角カナ。全角で書くと一生ヒットしません。
const TWIN = { rank: 1, name: 'プライベートｼﾝｸﾞﾙﾂｲﾝ', label: 'プライベート シングルツイン' };

const CONFIG = {
  topUrl:     'https://booking.ferry-sunflower.co.jp/web/yoyaku/',
  bookingUrl: 'https://booking.ferry-sunflower.co.jp/web/yoyaku/',

  josenNaiyo: '03',                      // 03 = 徒歩でご利用
  passengers: { '大人': 1, '幼児': 1 },

  // 監視する便。出港日を過ぎたものは自動でスキップします
  targets: [
    {
      y: 2026, m: 9, d: 21, line: '21',
      route: '大阪1 → 別府',
      holding: 'プライベートシングル（確保済み）',
      grades: [TWIN],
    },
    {
      y: 2026, m: 9, d: 23, line: '21',
      route: '大阪1 → 別府（往路）',
      holding: 'プライベートシングル（仮押さえ済み）',
      grades: [TWIN],
    },
    {
      y: 2026, m: 9, d: 24, line: '22',
      route: '別府 → 大阪1（復路）',
      holding: 'プライベートシングル（仮押さえ済み）',
      grades: [TWIN],
    },
  ],

  // --- 通知の間引き ---
  // 空席が「出た瞬間」は必ず即通知。そのあと空きが続いているあいだの再通知の間隔。
  remindMinutesSlack: 30,   // Slackは無制限なので短め
  remindMinutesLine:  60,   // LINEは無料プラン月200通なので長め

  // --- 静音時間（日本時間）---
  // この時間帯はLINEを鳴らしません（Slackには記録として残ります）。
  // 明けた直後のチェックで、まだ空いていればLINEが飛びます。
  quietFromJST: 1,
  quietToJST:   5,

  // --- 予約サイトの定期メンテナンス（日本時間）---
  // この時間帯は最初から見に行かず、エラーにもしません。前後に余裕を持たせています。
  maintenanceFromJST: '02:50',
  maintenanceToJST:   '05:20',
};

const STATE_FILE = 'state/last.json';

// ===== 通知先（GitHub Secrets から自動で読み込み。設定した分だけ送ります）=====
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

function tagDate(t) {
  return String(t.y) + String(t.m).padStart(2, '0') + String(t.d).padStart(2, '0') + '-' + t.line;
}

function ymdNum(t) {
  return t.y * 10000 + t.m * 100 + t.d;
}

// 実行環境のタイムゾーンによらず「日本時間の今」を出す
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

// 予約サイトのメンテナンス時間帯か（"HH:MM" を分に直して比較。日またぎにも対応）
function inMaintenanceJST() {
  const toMin = function (s) {
    const p = String(s).split(':');
    return Number(p[0]) * 60 + Number(p[1] || 0);
  };
  const j = nowJST();
  const now = j.getHours() * 60 + j.getMinutes();
  const a = toMin(CONFIG.maintenanceFromJST);
  const b = toMin(CONFIG.maintenanceToJST);
  return a <= b ? (now >= a && now < b) : (now >= a || now < b);
}

// メンテナンス等でページが出ないときに投げる印つきのエラー
function skipError(msg) {
  const e = new Error(msg);
  e.isSkip = true;
  return e;
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
    await page.screenshot({ path: 'debug/' + tag + '.png', fullPage: true });
    console.log('     debug/' + tag + '.html と .png を保存しました');
  } catch (e) {
    console.log('     デバッグ保存に失敗: ' + e.message);
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

function buildMessage(groups, key) {
  let msg = '【さんふらわあ 空席発生】\n徒歩・大人1/幼児1\n';
  for (let i = 0; i < groups.length; i++) {
    if (groups[i][key].length === 0) continue;
    msg += '\n■ ' + groups[i].label + '　' + groups[i].route + '\n';
    if (groups[i].sailing) msg += groups[i].sailing + '\n';
    msg += '（いま ' + groups[i].holding + '）\n';
    msg += groups[i][key].join('\n') + '\n';
  }
  msg += '\n▼すぐ予約\n' + CONFIG.bookingUrl;
  return msg;
}

// ============================================================
// 1便分をチェックする
// ============================================================
async function checkOne(page, target) {
  // ---- 1. 予約TOP -> 「ログインせず運賃を調べる」-> 利用内容入力（Reserve1030）----
  // 注意: 予約TOPにも #date があるが、それは「予約照会」用（name=Inquery_BoardingDate）。
  //       利用内容入力画面に来たかどうかは #Ouro_Line の有無で判定する。
  await page.goto(CONFIG.topUrl, { waitUntil: 'networkidle2', timeout: 45000 });

  if (!(await page.$('#Ouro_Line'))) {
    try {
      await page.waitForSelector('button.btn-Reserve', { timeout: 20000 });
    } catch (e) {
      // ボタンが出ない＝メンテナンス中や障害の可能性。ページの文言で見分ける
      const note = await page.evaluate(function () {
        return (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 300);
      });
      const words = ['メンテナンス', 'ただいま', '停止', 'ご利用いただけません', 'しばらく'];
      let hit = false;
      for (let i = 0; i < words.length; i++) {
        if (note.indexOf(words[i]) !== -1) { hit = true; break; }
      }
      if (hit) throw skipError('予約サイトが一時的に利用できません: ' + note.slice(0, 120));
      throw new Error('予約TOPに「ログインせず運賃を調べる」が出ません。画面文言: ' + note.slice(0, 120));
    }

    await Promise.all([
      page.click('button.btn-Reserve'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    ]).catch(function () { /* 遷移検知に失敗しても下のフォールバックで拾う */ });

    if (!(await page.$('#Ouro_Line'))) {
      console.log('     ボタンで進めなかったので form#Reserve を直接送信します');
      await Promise.all([
        page.evaluate(function () {
          const f = document.getElementById('Reserve');
          if (f) f.submit();
        }),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      ]).catch(function () { /* 遷移済みなら何もしない */ });
    }
  }

  await page.waitForSelector('#Ouro_Line', { timeout: 20000 });

  // ---- 2-1. 乗船日（jQuery UI datepicker の API 経由で正しい書式にさせる）----
  const dateSet = await page.evaluate(function (t) {
    // 乗船日欄は name で特定する（予約照会用の #date と取り違えないため）
    const el = document.querySelector('input[name="Ouro_BoardingDate"]')
            || document.getElementById('date');
    if (!el) return { via: 'not-found', value: '' };
    const jq = window.jQuery || window.$;
    if (jq && jq(el).hasClass('hasDatepicker')) {
      jq(el).datepicker('setDate', new Date(t.y, t.m - 1, t.d));
      jq(el).trigger('change');
      return { via: 'datepicker', value: el.value };
    }
    const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(t.y, t.m - 1, t.d).getDay()];
    const v = t.y + '年' + String(t.m).padStart(2, '0') + '月'
            + String(t.d).padStart(2, '0') + '日(' + w + ')';
    el.removeAttribute('readonly');
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { via: 'manual', value: el.value };
  }, { y: target.y, m: target.m, d: target.d });
  console.log('  乗船日: "' + dateSet.value + '" [' + dateSet.via + ']');
  if (!dateSet.value) throw new Error('乗船日が入力できていません（選択可能な期間外かもしれません）');

  // ---- 2-2. ご利用区間（往路・復路で切り替わる）----
  const lineOk = await page.evaluate(function (v) {
    const sel = document.getElementById('Ouro_Line');
    if (!sel) return '';
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === v) {
        sel.value = v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return sel.options[i].textContent.replace(/\s+/g, '');
      }
    }
    return '';
  }, target.line);
  if (!lineOk) throw new Error('区間コード ' + target.line + ' が選択肢にありません');
  console.log('  区間: ' + lineOk + '（' + target.line + '）');

  // ---- 2-3. ご乗船内容（徒歩）----
  await page.click('#JosenNaiyo' + CONFIG.josenNaiyo);
  await page
    .waitForFunction(function () {
      const el = document.getElementById('Car_Len');
      return !el || el.offsetParent === null;
    }, { timeout: 10000 })
    .catch(function () { console.log('  車輌欄の非表示は未確認のまま続行'); });

  // ---- 2-4. 人数（name で直接指定。実ページで確認済みの4項目）----
  const pax = await page.evaluate(function (want) {
    const map = {
      'RiyoNaiyo.Number_Of_Adults':   want['大人'] || 0,
      'RiyoNaiyo.Number_Of_Children': want['小人'] || 0,
      'RiyoNaiyo.Number_Of_Yoji':     want['幼児'] || 0,
      'RiyoNaiyo.Number_Of_Nyuji':    want['乳児'] || 0,
    };
    const done = [];
    const missing = [];
    const names = Object.keys(map);
    for (let i = 0; i < names.length; i++) {
      const sel = document.querySelector('select[name="' + names[i] + '"]');
      if (!sel) { missing.push(names[i]); continue; }
      const v = String(map[names[i]]);
      let ok = false;
      for (let o = 0; o < sel.options.length; o++) {
        if (sel.options[o].value === v) { ok = true; break; }
      }
      if (!ok) { missing.push(names[i] + '(値' + v + 'なし)'); continue; }
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      done.push(names[i].replace('RiyoNaiyo.Number_Of_', '') + '=' + v);
    }
    return { done: done, missing: missing };
  }, CONFIG.passengers);

  console.log('  人数: ' + pax.done.join(' / '));
  if (pax.missing.length) {
    throw new Error('人数欄が見つかりませんでした: ' + pax.missing.join(', '));
  }

  // ---- 3. 送信 ----
  await page.evaluate(function () {
    const form = document.querySelector('form.MoveNext');
    if (!form) throw new Error('form.MoveNext がありません');
    const btn = form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
    if (btn) { btn.click(); return; }
    form.submit();
  });
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });

  if (!/Reserve1020/i.test(page.url())) {
    const msg = await page.evaluate(function () {
      const nodes = document.querySelectorAll(
        '.field-validation-error, .validation-summary-errors, .box-yellow, .txt-red'
      );
      const arr = [];
      for (let i = 0; i < nodes.length; i++) {
        const t = nodes[i].innerText.trim();
        if (t) arr.push(t);
      }
      return arr.join(' / ').slice(0, 600);
    });
    throw new Error('空席照会画面へ遷移できませんでした。画面メッセージ: ' + (msg || '(なし)'));
  }

  // ---- 4. 空席テーブルの解析 ----
  const result = await page.evaluate(function (targets) {
    const rows = [];
    const seen = [];
    const tables = document.querySelectorAll('table.tbl-vacancy');

    for (let i = 0; i < tables.length; i++) {
      const tbl = tables[i];

      // 直前にある便名の見出し（h2.accordion-ttl）を遡って探す
      let ttl = '';
      let n = tbl.previousElementSibling;
      let up = tbl.parentElement;
      for (let guard = 0; guard < 50; guard++) {
        if (n) {
          if (/^H[1-6]$/.test(n.tagName)) { ttl = n.innerText.replace(/\s+/g, ' ').trim(); break; }
          n = n.previousElementSibling;
          continue;
        }
        if (!up) break;
        n = up.previousElementSibling;
        up = up.parentElement;
      }

      const trs = tbl.querySelectorAll('tbody tr');
      for (let j = 0; j < trs.length; j++) {
        const cellNodes = trs[j].querySelectorAll('th, td');
        const cells = [];
        for (let k = 0; k < cellNodes.length; k++) {
          cells.push(cellNodes[k].innerText.replace(/\s+/g, '').trim());
        }

        // 等級セルを名前で特定 -> 空席状況はその3つ右（等級/イメージ/運賃/空席状況）
        let gi = -1;
        let hit = null;
        for (let k = 0; k < cells.length && gi === -1; k++) {
          for (let t = 0; t < targets.length; t++) {
            if (cells[k].indexOf(targets[t].name) !== -1) { gi = k; hit = targets[t]; break; }
          }
        }
        if (gi === -1) {
          if (cells.length >= 4 && cells[1]) seen.push(cells[1]);
          continue;
        }

        rows.push({
          sailing: ttl,
          rank: hit.rank,
          name: hit.name,
          label: hit.label,
          fare: cells[gi + 2] || '',
          status: cells[gi + 3] || '',
        });
      }
    }
    return { rows: rows, seen: seen, tableCount: tables.length };
  }, target.grades);

  if (result.rows.length !== target.grades.length) {
    console.log('  !! 監視対象 ' + target.grades.length + '件のうち '
      + result.rows.length + '件しか見つかりません');
    console.log('     ページ上の等級名: ' + JSON.stringify(result.seen));
  }
  if (result.rows.length === 0) return { sailing: '', rows: [] };

  result.rows.sort(function (a, b) { return a.rank - b.rank; });

  // ---- 5. 判定（ページ凡例どおり: ○ または 1以上の数字 = 空席あり）----
  const rows = [];
  for (let i = 0; i < result.rows.length; i++) {
    const r = result.rows[i];
    const s = r.status;
    const numMatch = s.match(/\d+/);
    const num = numMatch ? Number(numMatch[0]) : 0;
    const isFull   = s.indexOf('×') !== -1 || s.indexOf('満席') !== -1;
    const isNoSale = /^[-−－ー—–]$/.test(s);
    const isWait   = s.indexOf('空席待ち') !== -1;
    const hasMark  = s.indexOf('○') !== -1 || s.indexOf('◯') !== -1 || s.indexOf('〇') !== -1;
    const open = !isFull && !isNoSale && !isWait && (hasMark || num >= 1);

    console.log('  【第' + r.rank + '希望】' + r.label + ' [' + s + '] ' + r.fare
      + ' -> ' + (open ? '★空きあり' : '空きなし'));
    rows.push({ rank: r.rank, name: r.name, label: r.label, status: s, fare: r.fare, open: open });
  }

  return { sailing: result.rows[0].sailing || '', rows: rows };
}

// ============================================================
async function run() {
  const j = nowJST();
  const quiet = isQuietJST();
  console.log('=== さんふらわあ空席監視（徒歩・大人1/幼児1）===');
  for (let i = 0; i < CONFIG.targets.length; i++) {
    const t = CONFIG.targets[i];
    console.log('  ・' + fmtDate(t) + ' ' + t.route + ' / いま ' + t.holding);
  }
  console.log('日本時間 ' + fmtDate({ y: j.getFullYear(), m: j.getMonth() + 1, d: j.getDate() }) + ' '
    + String(j.getHours()).padStart(2, '0') + ':' + String(j.getMinutes()).padStart(2, '0')
    + (quiet ? '（静音時間帯：LINEは鳴らしません）' : ''));

  // --- 通知テストモード ---
  if (TEST_NOTIFY) {
    console.log('*** TEST_NOTIFY=true のため、通知テストのみ実行します ***');
    const list = CONFIG.targets.map(function (t) { return fmtDate(t) + ' ' + t.route; }).join('\n');
    const msg = '【テスト送信】さんふらわあ空席監視\n'
      + 'この文面が届いていれば、通知の設定は正常です。\n\n' + list;
    const a = await sendSlack(msg);
    const b = await sendLine(msg);
    if (!a && !b) process.exitCode = 1;
    return;
  }

  // 予約サイトのメンテナンス時間帯は、見に行かずに静かに終わる
  if (inMaintenanceJST()) {
    console.log('> 予約サイトのメンテナンス時間帯（'
      + CONFIG.maintenanceFromJST + '〜' + CONFIG.maintenanceToJST
      + '）のため、今回はスキップします。');
    return;
  }

  const prev = loadState();
  const next = {};
  const now = Date.now();
  const remindSlackMs = CONFIG.remindMinutesSlack * 60 * 1000;
  const remindLineMs  = CONFIG.remindMinutesLine * 60 * 1000;

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

  const today = todayJST();
  const groups = [];
  let checked = 0;
  let skipped = 0;
  let failed = 0;
  let openCount = 0;

  try {
    for (let i = 0; i < CONFIG.targets.length; i++) {
      const t = CONFIG.targets[i];
      const label = fmtDate(t);
      const keyHead = label + '|' + t.line + '|';
      console.log('');
      console.log('########## ' + label + ' ' + t.route + ' ##########');

      if (ymdNum(t) < ymdNum(today)) {
        console.log('  出港日を過ぎているのでスキップします');
        continue;
      }

      let r;
      try {
        r = await checkOne(page, t);
        checked++;
      } catch (e) {
        if (e.isSkip) {
          console.log('  > スキップ: ' + e.message);
          skipped++;
        } else {
          failed++;
          console.error('  !! エラー: ' + e.message);
          await saveDebug(page, 'error-' + tagDate(t));
        }
        if (prev) {
          const keys = Object.keys(prev);
          for (let k = 0; k < keys.length; k++) {
            if (keys[k].indexOf(keyHead) === 0) next[keys[k]] = prev[keys[k]];
          }
        }
        continue;
      }

      const slackLines = [];
      const lineLines = [];

      for (let jj = 0; jj < r.rows.length; jj++) {
        const row = r.rows[jj];
        const key = keyHead + row.name;
        const was = prev ? prev[key] : null;

        if (!row.open) {
          next[key] = { open: false, lastSlack: 0, lastLine: 0 };
          continue;
        }

        openCount++;
        const fresh = !was || !was.open;
        const text = '・' + row.label + '：' + row.status + '　' + row.fare;

        const slackDue = fresh || (now - (was.lastSlack || 0)) >= remindSlackMs;
        const lineDue  = (fresh || (now - (was.lastLine || 0)) >= remindLineMs) && !quiet;

        if (slackDue) slackLines.push(text);
        if (lineDue)  lineLines.push(text);

        next[key] = {
          open: true,
          lastSlack: slackDue ? now : ((was && was.lastSlack) || now),
          lastLine:  lineDue  ? now : ((was && was.lastLine)  || 0),
        };

        console.log('  → ' + row.label + ': ' + (fresh ? '新規' : '継続中')
          + ' / Slack ' + (slackDue ? '送る' : '見送り')
          + ' / LINE ' + (lineDue ? '送る' : (quiet ? '静音中' : '見送り')));
      }

      if (slackLines.length || lineLines.length) {
        groups.push({
          label: label, route: t.route, holding: t.holding, sailing: r.sailing,
          slackLines: slackLines, lineLines: lineLines,
        });
      }
    }

    // ---- 通知 ----
    console.log('');
    let anySlack = 0;
    let anyLine = 0;
    for (let i = 0; i < groups.length; i++) {
      anySlack += groups[i].slackLines.length;
      anyLine  += groups[i].lineLines.length;
    }

    if (anySlack > 0) await sendSlack(buildMessage(groups, 'slackLines'));
    if (anyLine > 0)  await sendLine(buildMessage(groups, 'lineLines'));

    if (anySlack === 0 && anyLine === 0) {
      if (openCount > 0) {
        console.log('> 空席は続いていますが、通知済みのため今回は送りません'
          + (quiet ? '（静音時間帯。明けたらLINEも鳴らします）' : ''));
      } else if (checked > 0) {
        console.log('> シングルツインの空きなし。監視を継続します。');
      } else if (failed === 0 && skipped === 0) {
        console.log('> 監視対象の日付がすべて過ぎています。ワークフローを止めて構いません。');
      }
    }
  } finally {
    await browser.close();
    saveState(next);
    console.log('=== 終了（確認 ' + checked + '便 / スキップ ' + skipped
      + '便 / 失敗 ' + failed + '便）===');
  }

  if (failed > 0) process.exitCode = 1;
}

run();
