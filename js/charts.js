/* ECharts helpers: colors come from CSS custom properties so light/dark stay in one place. */
(function (BC) {
  "use strict";
  const live = new Set();

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function theme() {
    return {
      text: css("--text-primary"),
      text2: css("--text-secondary"),
      muted: css("--text-muted"),
      grid: css("--grid"),
      surface: css("--surface-1"),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css(`--series-${i}`)),
      income: css("--income"),
      expense: css("--expense"),
      assets: css("--assets"),
      liabilities: css("--liabilities"),
      net: css("--text-primary"),
    };
  }

  // Shared tooltip and axis styling.
  function base(t) {
    return {
      textStyle: { fontFamily: "inherit", color: t.text2 },
      tooltip: {
        backgroundColor: t.surface,
        borderColor: t.grid,
        textStyle: { color: t.text, fontSize: 12 },
        extraCssText: "box-shadow: 0 4px 16px rgba(0,0,0,.12); border-radius: 8px;",
      },
      animationDuration: 300,
    };
  }

  function axisStyle(t) {
    return {
      axisLine: { lineStyle: { color: t.grid } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: t.grid, type: [3, 3] } },
    };
  }

  function mount(el, option) {
    const chart = echarts.init(el, null, { renderer: "svg" });
    chart.setOption(option);
    live.add(chart);
    return chart;
  }

  function disposeAll() {
    live.forEach((c) => c.dispose());
    live.clear();
  }

  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => live.forEach((c) => c.resize()), 120);
  });

  BC.charts = { theme, base, axisStyle, mount, disposeAll };
})((window.BC = window.BC || {}));
