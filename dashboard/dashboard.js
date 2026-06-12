const FIREBASE_DB_URL = 'https://snowy-hr-report-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_ROOT = 'c4cTickets_test';
const DASHBOARD_ROOT = 'claimsReceivedDashboard';
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const IN_FIELD_KEYWORDS = ['in field', 'in-field', 'infield', 'field warranty'];
const PRE_DELIVERY_KEYWORDS = ['pre delivery', 'pre-delivery', 'predelivery', 'pdi'];

const chartCanvas = document.getElementById('claimsChart');
const refreshButton = document.getElementById('refreshButton');
const lastUpdated = document.getElementById('lastUpdated');
const statusMessage = document.getElementById('statusMessage');
let claimsChart;

function firebaseUrl(path) {
  return `${FIREBASE_DB_URL}/${path}.json`;
}

async function fetchJson(path) {
  const response = await fetch(firebaseUrl(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Firebase request failed for ${path}: ${response.status}`);
  }
  return response.json();
}

function asObject(node) {
  if (!node) return {};
  if (Array.isArray(node)) {
    return Object.fromEntries(node.map((value, index) => [String(index), value]).filter(([, value]) => value));
  }
  return typeof node === 'object' ? node : {};
}

function normalizeClaimText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAnyKeyword(searchText, keywords) {
  const compactText = searchText.replace(/\s/g, '');
  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeClaimText(keyword);
    return searchText.includes(normalizedKeyword) || compactText.includes(normalizedKeyword.replace(/\s/g, ''));
  });
}

function classifyTicket(ticket) {
  const preferredFields = [
    'TicketTypeText',
    'TicketType',
    'TicketName',
    'Subject',
    'Name',
    'Category',
    'ServiceCategory',
    'ClaimType',
    'WarrantyClaimType',
    'Claim Type',
    'Warranty Claim Type',
    'Warranty Type',
  ];
  const values = preferredFields.map((field) => ticket?.[field]);

  // Fallback for custom C4C field names: include all scalar ticket values.
  Object.values(ticket || {}).forEach((value) => {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      values.push(value);
    }
  });

  const searchText = values.map(normalizeClaimText).filter(Boolean).join(' ');
  if (matchesAnyKeyword(searchText, PRE_DELIVERY_KEYWORDS)) return 'preDelivery';
  if (matchesAnyKeyword(searchText, IN_FIELD_KEYWORDS)) return 'inField';
  return '';
}

function parseCreatedOnMonth(createdOn) {
  const raw = String(createdOn ?? '').trim();
  if (!raw) return '';

  const directMatch = raw.match(/^(\d{4})[-/](\d{1,2})/);
  if (directMatch) {
    const month = Number(directMatch[2]);
    if (month >= 1 && month <= 12) return `${directMatch[1]}-${String(month).padStart(2, '0')}`;
  }

  const sapDateMatch = raw.match(/\/Date\((-?\d+)/);
  if (sapDateMatch) {
    const dt = new Date(Number(sapDateMatch[1]));
    if (!Number.isNaN(dt.getTime())) return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
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

function iterMonthKeys(startMonth, endMonth) {
  const [startYear, startMonthNumber] = String(startMonth).split('-').map(Number);
  const [endYear, endMonthNumber] = String(endMonth).split('-').map(Number);
  if (!startYear || !startMonthNumber || !endYear || !endMonthNumber) return [];

  const out = [];
  let year = startYear;
  let month = startMonthNumber;
  while (year < endYear || (year === endYear && month <= endMonthNumber)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return out;
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

function buildSeriesFromTickets(ticketsNode) {
  const tickets = asObject(ticketsNode);
  const monthly = {};
  let matchedTicketCount = 0;
  let unmatchedTicketCount = 0;
  let missingCreatedOnCount = 0;

  Object.values(tickets).forEach((node) => {
    const ticket = node?.ticket || node;
    if (!ticket || typeof ticket !== 'object') return;

    const bucket = classifyTicket(ticket);
    if (!bucket) {
      unmatchedTicketCount += 1;
      return;
    }

    const month = parseCreatedOnMonth(ticket.CreatedOn);
    if (!month) {
      missingCreatedOnCount += 1;
      return;
    }

    matchedTicketCount += 1;
    monthly[month] ||= { inField: 0, preDelivery: 0 };
    monthly[month][bucket] += 1;
  });

  const monthKeys = Object.keys(monthly).sort();
  const filledMonthKeys = monthKeys.length ? iterMonthKeys(monthKeys[0], monthKeys[monthKeys.length - 1]) : [];
  const series = filledMonthKeys.map((month) => ({
    month,
    label: formatMonthLabel(month),
    inField: Number(monthly[month]?.inField || 0),
    preDelivery: Number(monthly[month]?.preDelivery || 0),
  }));

  return {
    series,
    latestSyncAt: null,
    source: `${FIREBASE_ROOT}/tickets (live fallback)`,
    matchedTicketCount,
    unmatchedTicketCount,
    missingCreatedOnCount,
    usedLiveFallback: true,
  };
}

async function fetchSyncTimestamp() {
  const candidates = ['claimsReceivedLatestSyncAt', 'ticketCoreSyncAt', 'ticketSoSyncAt'];
  const values = await Promise.allSettled(candidates.map((key) => fetchJson(`${FIREBASE_ROOT}/${key}`)));
  return values.map((result) => (result.status === 'fulfilled' ? result.value : null)).find(Boolean) || null;
}

async function fetchDashboardData() {
  const dashboardData = (await fetchJson(`${FIREBASE_ROOT}/${DASHBOARD_ROOT}`)) || {};
  if (normalizeSeries(dashboardData).length) return { ...dashboardData, usedLiveFallback: false };

  const [ticketsNode, syncTimestamp] = await Promise.all([
    fetchJson(`${FIREBASE_ROOT}/tickets`),
    fetchSyncTimestamp(),
  ]);
  return { ...buildSeriesFromTickets(ticketsNode), latestSyncAt: syncTimestamp };
}

function makePointLabels() {
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
    plugins: [makePointLabels()],
  });
}

function formatSyncText(timestamp) {
  if (timestamp) return `Last sync: ${new Date(timestamp).toLocaleString()}`;
  return `Last refresh: ${new Date().toLocaleString()}`;
}

async function refreshDashboard() {
  refreshButton.disabled = true;
  statusMessage.textContent = 'Refreshing data…';
  try {
    const data = await fetchDashboardData();
    const series = normalizeSeries(data);
    renderChart(series);
    lastUpdated.textContent = formatSyncText(data.latestSyncAt);

    if (!series.length) {
      statusMessage.textContent = `No matching in-field/pre-delivery claims found. Checked source: ${data.source || `${FIREBASE_ROOT}/${DASHBOARD_ROOT}`}.`;
    } else if (data.usedLiveFallback) {
      statusMessage.textContent = `Loaded ${series.length} month(s) directly from tickets because dashboard metrics were not generated yet. Matched ${data.matchedTicketCount || 0} tickets.`;
    } else {
      statusMessage.textContent = `Loaded ${series.length} month(s). Data source: ${data.source || `${FIREBASE_ROOT}/${DASHBOARD_ROOT}`}.`;
    }
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
