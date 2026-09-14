'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');

// ============================================================
// 監視条件（ここだけ書き換えれば他の日・他の航路にも使えます）
// ============================================================
const CONFIG = {
  topUrl:      'https://booking.ferry-sunflower.co.jp/web/yoyaku/',
  bookingUrl:  'https://booking.ferry-sunflower.co.jp/web/yoyaku/',

  targetDate: { y: 2026, m: 9, d: 21 },   // 乗船日
  ouroLine:   '21',                       // 21 = 大阪1 → 別府
  josenNaiyo: '03',                       // 03 = 徒歩でご利用
  passengers: { '大人': 1, '幼児': 1 },   // ラベル文字列 → 人数

  targetGrades: [
    'スーペリアシングル',
    'スタンダードシングル',
    'プライベートシングル',
    'プライベートベッドレディース',
  ],
};

// ===== 通知先（GitHub Secrets から自動で読み込み。設定した分だけ送ります）=====
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const LINE_TOKEN    = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID  = process.env.LINE_USER_ID;
const TEST_NOTIFY   = process.env.TEST_NOTIFY === 'true';

// ============================================================
// 通知（Slack と LINE の両方へ。設定されている先だけに送ります）
// ============================================================
async function notify(message) {
  let sent = 0;
  const errs = [];

  if (SLACK_WEBHOOK) {
    try {
      const res = await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + body);
      console.log('  OK Slack 送信成功');
      sent++;
    } catch (e) {
      errs.push('Slack: ' + e.message);
    }
  }

  if (LINE_TOKEN && LINE_USER_ID) {
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
      sent++;
    } catch (e) {
      errs.push('LINE: ' + e.message);
    }
  }

  if (errs.length) console.error('  通知エラー: ' + errs.join(' / '));
  if (sent === 0) {
    console.log('  !! 通知先が未設定、または全て失敗しました。本文は以下:');
    console.log(message);
  }
  return sent;
}

function saveDebug(page, tag) {
  return (async () => {
    try {
      fs.mkdirSync('debug', { recursive: true });
      fs.writeFileSync('debug/' + tag + '.html', await page.content());
      await page.screenshot({ path: 'debug/' + tag + '.png', fullPage: true });
      console.log('  debug/' + tag + '.html と .png を保存しました');
    } catch (e) {
      console.log('  デバッグ保存に失敗: ' + e.message);
    }
  })();
}

// ============================================================
async function run() {
  const d = CONFIG.targetDate;
  const dateLabel = d.y + '/' + String(d.m).padStart(2, '0') + '/' + String(d.d).padStart(2, '0');
  console.log('=== さんふらわあ空席監視 ' + dateLabel + ' 大阪1 -> 別府(徒歩) ===');

  // --- 通知テストモード ---
  if (TEST_NOTIFY) {
    console.log('*** TEST_NOTIFY=true のため、通知テストのみ実行します ***');
    const n = await notify(
      '【テスト送信】さんふらわあ空席監視\n' +
      'この文面が届いていれば、通知の設定は正常です。\n' +
      '監視対象: ' + dateLabel + ' 大阪1 -> 別府（徒歩）'
    );
    if (n === 0) process.exitCode = 1;
    return;
  }

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

  try {
    // ---- 1. 予約TOP -> 「ログインせず運賃を調べる」-> 利用内容入力（Reserve1030）----
    // 注意: 予約TOPにも #date があるが、それは「予約照会」用（name=Inquery_BoardingDate）。
    //       利用内容入力画面に来たかどうかは #Ouro_Line の有無で判定する。
    console.log('1. 予約TOPへアクセス');
    await page.goto(CONFIG.topUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    console.log('   現在URL: ' + page.url());

    if (!(await page.$('#Ouro_Line'))) {
      console.log('   「ログインせず運賃を調べる」をクリック');
      await page.waitForSelector('button.btn-Reserve', { timeout: 20000 });
      const navOk = await Promise.all([
        page.click('button.btn-Reserve'),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      ]).then(function () { return true; }).catch(function () { return false; });
      console.log('   クリック後URL: ' + page.url() + '（遷移検知: ' + navOk + '）');

      if (!(await page.$('#Ouro_Line'))) {
        console.log('   ボタンで進めなかったので form#Reserve を直接送信します');
        await Promise.all([
          page.evaluate(function () {
            const f = document.getElementById('Reserve');
            if (f) f.submit();
          }),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        ]).catch(function () { /* 遷移済みなら何もしない */ });
        console.log('   再送信後URL: ' + page.url());
      }
    }

    await page.waitForSelector('#Ouro_Line', { timeout: 20000 });
    console.log('   利用内容入力画面に到達: ' + page.url());

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
    }, CONFIG.targetDate);
    console.log('2-1. 乗船日セット [' + dateSet.via + '] -> "' + dateSet.value + '"');
    if (!dateSet.value) throw new Error('乗船日が入力できていません（選択可能な期間外かもしれません）');

    // ---- 2-2. ご利用区間 ----
    await page.select('#Ouro_Line', CONFIG.ouroLine);
    console.log('2-2. 区間セット -> ' + CONFIG.ouroLine);

    // ---- 2-3. ご乗船内容（徒歩）。車輌欄が消えるのを待って確認 ----
    await page.click('#JosenNaiyo' + CONFIG.josenNaiyo);
    await page
      .waitForFunction(function () {
        const el = document.getElementById('Car_Len');
        return !el || el.offsetParent === null;
      }, { timeout: 10000 })
      .then(function () { console.log('2-3. 徒歩を選択（車輌欄が非表示になったのを確認）'); })
      .catch(function () { console.log('2-3. 徒歩を選択（車輌欄の非表示は未確認のまま続行）'); });

    // ---- 2-4. 人数（欄を自動で探して埋める。同時に全入力欄をログ出力）----
    const pax = await page.evaluate(function (want) {
      const out = { blocks: [], set: [] };
      const dls = document.querySelectorAll('dl.entryBox');
      for (let i = 0; i < dls.length; i++) {
        const dl = dls[i];
        const dtEl = dl.querySelector('dt');
        const dt = (dtEl ? dtEl.innerText : '').replace(/\s+/g, '');

        const ctrls = [];
        const nodes = dl.querySelectorAll('select, input[type="number"], input[type="text"]');
        for (let j = 0; j < nodes.length; j++) {
          const c = nodes[j];
          const lab = c.closest('label');
          ctrls.push({
            name: c.name,
            id: c.id,
            tag: c.tagName,
            label: (lab ? lab.innerText : '').replace(/\s+/g, ''),
          });
        }
        if (ctrls.length) out.blocks.push({ dt: dt, controls: ctrls });

        if (!/人数|乗船人員|ご利用人数|ご乗船人数/.test(dt)) continue;

        const keys = Object.keys(want).sort(function (a, b) { return b.length - a.length; });
        const sels = dl.querySelectorAll('select');
        for (let k = 0; k < sels.length; k++) {
          const sel = sels[k];
          const lab = sel.closest('label');
          const labelText = ((lab ? lab.innerText : '') || (sel.parentElement ? sel.parentElement.innerText : ''))
            .replace(/\s+/g, '');
          let hit = null;
          for (let m = 0; m < keys.length; m++) {
            if (labelText.indexOf(keys[m]) !== -1) { hit = keys[m]; break; }
          }
          const v = String(hit ? want[hit] : 0);
          let ok = false;
          for (let o = 0; o < sel.options.length; o++) {
            if (sel.options[o].value === v) { ok = true; break; }
          }
          if (ok) {
            sel.value = v;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            out.set.push({ name: sel.name, label: labelText, value: v });
          }
        }
      }
      return out;
    }, CONFIG.passengers);

    console.log('2-4. ページ上の入力欄一覧:');
    console.log(JSON.stringify(pax.blocks, null, 1));
    console.log('2-4. 人数としてセットした値: ' + JSON.stringify(pax.set));
    if (pax.set.length === 0) {
      console.log('  !! 人数欄を自動特定できませんでした。上の一覧を共有してください');
    }

    // ---- 3. 送信 ----
    const how = await page.evaluate(function () {
      const form = document.querySelector('form.MoveNext');
      if (!form) return 'no-form';
      const btn = form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
      if (btn) {
        btn.click();
        return 'button:' + ((btn.value || btn.innerText || '').trim());
      }
      form.submit();
      return 'form.submit()';
    });
    console.log('3. 検索を実行（' + how + '）');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });
    console.log('   遷移先: ' + page.url());

    if (!/Reserve1020/i.test(page.url())) {
      const msg = await page.evaluate(function () {
        const sels = '.field-validation-error, .validation-summary-errors, .box-yellow, .txt-red';
        const nodes = document.querySelectorAll(sels);
        const arr = [];
        for (let i = 0; i < nodes.length; i++) {
          const t = nodes[i].innerText.trim();
          if (t) arr.push(t);
        }
        return arr.join(' / ').slice(0, 800);
      });
      await saveDebug(page, 'no-transition');
      throw new Error('空席照会画面へ遷移できませんでした。画面メッセージ: ' + (msg || '(なし)'));
    }

    // ---- 4. 空席テーブルの解析 ----
    const result = await page.evaluate(function (targets) {
      const rows = [];
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
          let grade = null;
          for (let k = 0; k < cells.length && gi === -1; k++) {
            for (let t = 0; t < targets.length; t++) {
              if (cells[k].indexOf(targets[t]) !== -1) { gi = k; grade = targets[t]; break; }
            }
          }
          if (gi === -1) continue;

          const statusCell = cellNodes[gi + 3];
          rows.push({
            sailing: ttl,
            grade: grade,
            fare: cells[gi + 2] || '',
            status: cells[gi + 3] || '',
            hasLink: !!(statusCell && statusCell.querySelector('a')),
            cells: cells,
          });
        }
      }
      return { rows: rows, tableCount: tables.length };
    }, CONFIG.targetGrades);

    console.log('4. tbl-vacancy ' + result.tableCount + '件 / 対象等級 ' + result.rows.length + '行');

    if (result.rows.length === 0) {
      console.log('  !! 対象の等級が1行も見つかりません。等級名か行構造の確認が必要です');
      await saveDebug(page, 'no-rows');
      return;
    }

    // ---- 5. 判定（ページ凡例どおり: ○ または 1以上の数字 = 空席あり）----
    const hits = [];
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

      console.log(
        '【判定】' + r.grade + ' 状態:[' + s + '] 運賃:[' + r.fare + ']'
        + ' リンク:' + (r.hasLink ? 'あり' : 'なし')
        + ' -> ' + (open ? '★空きあり' : '空きなし')
      );
      if (open) hits.push('・' + r.grade + '：【' + s + '】 ' + r.fare);
    }

    // ---- 6. 通知 ----
    if (hits.length > 0) {
      const sailing = result.rows[0].sailing || '';
      await notify(
        '【さんふらわあ 空席発生】\n\n'
        + '乗船日: ' + dateLabel + '\n'
        + (sailing ? sailing + '\n' : '')
        + '区間: 大阪1 -> 別府（徒歩・大人1/幼児1）\n\n'
        + hits.join('\n') + '\n\n'
        + '▼すぐ予約\n' + CONFIG.bookingUrl
      );
    } else {
      console.log('> 対象等級に空きなし。監視を継続します。');
    }
  } catch (e) {
    console.error('!! エラー: ' + e.message);
    await saveDebug(page, 'error');
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('=== 終了 ===');
  }
}

run();
