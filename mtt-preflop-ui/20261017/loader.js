const mtt = new URLSearchParams(window.location.search).get('tool') === 'mtt-preflop';
if (mtt) {
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/mtt-preflop-ui/20261017/assets/index-DdakAyE6.css'; document.head.append(css);
  await import('./assets/index-B9Bvbuc9.js');
} else {
  await import('/assets/index-DWEdnfbU.js');
}
