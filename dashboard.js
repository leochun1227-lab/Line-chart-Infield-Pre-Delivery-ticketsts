const FIREBASE_DB_URL = 'https://snowy-hr-report-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_ROOT = 'c4cTickets_test';
const DASHBOARD_ROOT = 'claimsReceivedDashboard';
const AUTO_REFRESH_MS = 15 * 60 * 1000;

const chartCanvas = document.getElementById('claimsChart');
const refreshButton = document.getElementById('refreshButton');
const lastUpdated = document.getElementById('lastUpdated');
const statusMessage = document.getElementById('statusMessage');
let claimsChart;

function firebaseUrl(path) {
  return `${FIREBASE_DB_URL}/${path}.json`;
}

function formatMonthLabel(monthKey, fallback) {
  if (fallback) return fallback;
  const [year, month] = String(monthKey || '').split('-').map(Number);
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-AU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function normalizeSeries(data) {
  const series = Array.isArray(data?.series)
    ? data.series
    : Object.entries(data?.monthly || {}).map(([month, value]) => ({ month, ...value }));

  return series
    .filter((row) => row && row.month)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((row) => ({
      month: row.month,
      label: formatMonthLabel(row.month, row.label),
      inField: Number(row.inField || 0),
      preDelivery: Number(row.preDelivery || 0),
    }));
}

async function fetchDashboardData() {
  const response = await fetch(firebaseUrl(`${FIREBASE_ROOT}/${DASHBOARD_ROOT}`), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Firebase request failed: ${response.status}`);
  }
  const data = await response.json();
  return data || {};
}

function makePointLabels(values) {
  return {
    id: 'pointLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = '600 11px Inter, Segoe UI, Arial, sans-serif';
      ctx.fillStyle = '#111827';
      ctx.textAlign = 'center';
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        meta.data.forEach((point, index) => {
          const value = dataset.data[index];
          const yOffset = datasetIndex === 0 ? -9 : 15;
          ctx.fillText(String(value), point.x, point.y + yOffset);
        });
      });
      ctx.restore();
    },
  };
}

function renderChart(series) {
  const labels = series.map((row) => row.label);
  const inField = series.map((row) => row.inField);
  const preDelivery = series.map((row) => row.preDelivery);

  if (claimsChart) claimsChart.destroy();

  claimsChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'In Field Warranty Claims',
          data: inField,
          borderColor: '#5b9ded',
          backgroundColor: '#5b9ded',
          pointBackgroundColor: '#5b9ded',
          pointBorderColor: '#ffffff',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0,
        },
        {
          label: 'Pre Delivery Warranty Claims',
          data: preDelivery,
          borderColor: '#ff7438',
          backgroundColor: '#ff7438',
          pointBackgroundColor: '#ff7438',
          pointBorderColor: '#ffffff',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}` } },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 50, minRotation: 50, color: '#475467' },
        },
        y: {
          beginAtZero: true,
          suggestedMax: 900,
          ticks: { stepSize: 100, color: '#475467' },
          grid: { color: '#e6e9ef' },
        },
      },
    },
    plugins: [makePointLabels([...inField, ...preDelivery])],
  });
}

async function refreshDashboard() {
  refreshButton.disabled = true;
  statusMessage.textContent = 'Refreshing data…';
  try {
    const data = await fetchDashboardData();
    const series = normalizeSeries(data);
    renderChart(series);
    lastUpdated.textContent = data.latestSyncAt
      ? `Last sync: ${new Date(data.latestSyncAt).toLocaleString()}`
      : 'Last sync: not available';
    statusMessage.textContent = series.length
      ? `Loaded ${series.length} month(s). Data source: ${data.source || `${FIREBASE_ROOT}/${DASHBOARD_ROOT}`}.`
      : 'No monthly claims data found yet. Run the ticket sync to generate dashboard metrics.';
  } catch (error) {
    console.error(error);
    statusMessage.textContent = error.message;
    lastUpdated.textContent = 'Refresh failed';
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', refreshDashboard);
refreshDashboard();
window.setInterval(refreshDashboard, AUTO_REFRESH_MS);
