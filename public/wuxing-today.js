(() => {
  const $ = (id) => document.getElementById(id);
  const elements = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
  let displayedDate = '';

  function chinaToday() {
    const date = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return {
      year: Number(values.year), month: Number(values.month), day: Number(values.day),
      weekday: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(date),
    };
  }

  function fillTags(id, values) {
    $(id).replaceChildren(...values.map((value) => {
      const tag = document.createElement('span');
      tag.className = 'today-tag';
      tag.textContent = value;
      return tag;
    }));
  }

  function renderToday(force = false) {
    const { year, month, day, weekday } = chinaToday();
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!force && dateKey === displayedDate) return;
    try {
      if (!window.Solar) throw new Error('日历资料未载入');
      const lunar = window.Solar.fromYmd(year, month, day).getLunar();
      const dayGanZhi = lunar.getDayInGanZhi();
      $('today-date').textContent = `${year} 年 ${month} 月 ${day} 日 · ${weekday} · 北京时间`;
      $('today-pillar').textContent = `${dayGanZhi}日`;
      $('today-element').textContent = elements[dayGanZhi[0]] || '—';
      $('today-lunar').textContent = `农历 ${lunar.getMonthInChinese()}月${lunar.getDayInChinese()} · ${lunar.getDayTianShen()}${lunar.getDayTianShenType()}日`;
      $('today-nayin').textContent = lunar.getDayNaYin();
      fillTags('today-yi', lunar.getDayYi().slice(0, 6));
      fillTags('today-ji', lunar.getDayJi().slice(0, 6));
      $('today-error').hidden = true;
      displayedDate = dateKey;
    } catch (error) {
      $('today-error').textContent = `今天的黄历暂时无法载入：${error.message}`;
      $('today-error').hidden = false;
    }
  }

  renderToday(true);
  setInterval(renderToday, 60_000);
  window.addEventListener('pageshow', () => renderToday(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderToday(true);
  });
})();
