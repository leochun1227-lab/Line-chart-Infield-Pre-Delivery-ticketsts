const FIREBASE_DB_URL = 'https://snowy-hr-report-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_ROOT = 'c4cTickets_test';
const START_YEAR = 2024;
const DEFAULT_LOOKBACK_MONTHS = 24;
const YEAR_PLACEHOLDER = '----';
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const IN_FIELD_KEYWORDS = ['in field', 'in-field', 'infield', 'field warranty'];
const PRE_DELIVERY_KEYWORDS = ['pre delivery', 'pre-delivery', 'predelivery', 'pdi'];

const chartCanvas = document.getElementById('claimsChart');
const refreshButton = document.getElementById('refreshButton');
const yearSelect = document.getElementById('yearSelect');
const filterButton = document.getElementById('filterButton');
const filterPanel = document.getElementById('filterPanel');
const customRange = document.getElementById('customRange');
const startMonthInput = document.getElementById('startMonth');
const endMonthInput = document.getElementById('endMonth');
const applyFilterButton = document.getElementById('applyFilterButton');
const last12Button = document.getElementById('last12Button');
const clearFilterButton = document.getElementById('clearFilterButton');
const loadingOverlay = document.getElementById('loadingOverlay');
const lastUpdated = document.getElementById('lastUpdated');
const statusMessage = document.getElementById('statusMessage');
let claimsChart;
let latestDashboardData = null;
let customRangeActive = false;

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

  const auDateMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (auDateMatch) {
    const month = Number(auDateMatch[2]);
    if (month >= 1 && month <= 12) return `${auDateMatch[3]}-${String(month).padStart(2, '0')}`;
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

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthKeyToDate(monthKey) {
  const [year, month] = String(monthKey || '').split('-').map(Number);
  return new Date(Date.UTC(year || START_YEAR, (month || 1) - 1, 1));
}

function addMonths(monthKey, delta) {
  const dt = monthKeyToDate(monthKey);
  dt.setUTCMonth(dt.getUTCMonth() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function iterMonthKeys(startMonth, endMonth) {
  if (!startMonth || !endMonth || startMonth > endMonth) return [];
  const out = [];
  let cursor = startMonth;
  while (cursor <= endMonth) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

function makeMonthRow(month, counts = {}) {
  const inField = Number(counts.inField || 0);
  const preDelivery = Number(counts.preDelivery || 0);
  return {
    month,
    label: formatMonthLabel(month),
    inField,
    preDelivery,
    total: inField + preDelivery,
  };
}

function normalizeSeries(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.month)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((row) => makeMonthRow(row.month, row));
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
    if (Number(month.slice(0, 4)) < START_YEAR) return;

    matchedTicketCount += 1;
    monthly[month] ||= { inField: 0, preDelivery: 0 };
    monthly[month][bucket] += 1;
  });

  const currentMonth = getCurrentMonthKey();
  const dataMonths = Object.keys(monthly).sort();
  const latestMonth = dataMonths.length ? dataMonths[dataMonths.length - 1] : currentMonth;
  const minMonth = `${START_YEAR}-01`;
  const maxMonth = latestMonth > currentMonth ? currentMonth : latestMonth;
  const currentYear = Number(currentMonth.slice(0, 4));
  const maxYear = Math.max(currentYear, Number(maxMonth.slice(0, 4)));
  const availableYears = Array.from({ length: maxYear - START_YEAR + 1 }, (_, index) => START_YEAR + index);

  return {
    monthly,
    minMonth,
    maxMonth,
    latestMonth: maxMonth,
    availableYears,
    latestSyncAt: null,
    source: `${FIREBASE_ROOT}/tickets/*/ticket.CreatedOn`,
    matchedTicketCount,
    unmatchedTicketCount,
    missingCreatedOnCount,
  };
}

async function fetchSyncTimestamp() {
  const candidates = ['claimsReceivedLatestSyncAt', 'ticketCoreSyncAt', 'ticketSoSyncAt'];
  const values = await Promise.allSettled(candidates.map((key) => fetchJson(`${FIREBASE_ROOT}/${key}`)));
  return values.map((result) => (result.status === 'fulfilled' ? result.value : null)).find(Boolean) || null;
}

async function fetchDashboardData() {
  const [ticketsNode, syncTimestamp] = await Promise.all([
    fetchJson(`${FIREBASE_ROOT}/tickets`),
    fetchSyncTimestamp(),
  ]);
  const data = buildSeriesFromTickets(ticketsNode);
  return { ...data, latestSyncAt: syncTimestamp, usedLiveTickets: true };
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
  const maxValue = Math.max(0, ...inField, ...preDelivery);

  if (claimsChart) claimsChart.destroy();

  claimsChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'In Field Warranty Claims',
          data: inField,
          borderColor: '#4c8ee8',
          backgroundColor: '#4c8ee8',
          pointBackgroundColor: '#4c8ee8',
          pointBorderColor: '#ffffff',
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0.18,
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
          tension: 0.18,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}` } },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 45, minRotation: 45, color: '#475467' },
        },
        y: {
          position: 'right',
          beginAtZero: true,
          suggestedMax: Math.max(900, Math.ceil(maxValue / 100) * 100),
          ticks: { stepSize: 100, color: '#475467' },
          grid: { color: '#edf0f5' },
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

function setLoading(isLoading) {
  document.body.classList.toggle('is-loading', isLoading);
  loadingOverlay.hidden = !isLoading;
  refreshButton.disabled = isLoading;
}

function clampMonthValue(value, minMonth, maxMonth, fallback) {
  if (!value) return fallback;
  if (value < minMonth) return minMonth;
  if (value > maxMonth) return maxMonth;
  return value;
}

function syncControls(data) {
  const previousYear = yearSelect.value;
  const previousStart = startMonthInput.value;
  const previousEnd = endMonthInput.value;
  const years = data.availableYears || [START_YEAR];
  const yearOptions = years.map(String);

  yearSelect.innerHTML = [
    `<option value="">${YEAR_PLACEHOLDER}</option>`,
    ...years.map((year) => `<option value="${year}">${year}</option>`),
  ].join('');
  yearSelect.value = yearOptions.includes(previousYear) ? previousYear : '';

  startMonthInput.min = data.minMonth;
  startMonthInput.max = data.maxMonth;
  endMonthInput.min = data.minMonth;
  endMonthInput.max = data.maxMonth;

  const defaultStart = addMonths(data.maxMonth, -11) < data.minMonth ? data.minMonth : addMonths(data.maxMonth, -11);
  startMonthInput.value = clampMonthValue(previousStart, data.minMonth, data.maxMonth, defaultStart);
  endMonthInput.value = clampMonthValue(previousEnd, data.minMonth, data.maxMonth, data.maxMonth);
}

function getDefaultLookbackRange(data) {
  const defaultStart = addMonths(data.maxMonth, -(DEFAULT_LOOKBACK_MONTHS - 1));
  const start = defaultStart < data.minMonth ? data.minMonth : defaultStart;
  return {
    start,
    end: data.maxMonth,
    label: `the latest ${DEFAULT_LOOKBACK_MONTHS} months`,
  };
}

function getSelectedYearRange(data) {
  const selectedYear = yearSelect.value;
  if (!selectedYear) return getDefaultLookbackRange(data);

  const currentYear = getCurrentMonthKey().slice(0, 4);
  let end = `${selectedYear}-12`;

  if (selectedYear === currentYear && data.maxMonth.startsWith(currentYear)) {
    end = data.maxMonth;
  } else if (selectedYear === currentYear) {
    end = getCurrentMonthKey();
  } else if (end > data.maxMonth && selectedYear === data.maxMonth.slice(0, 4)) {
    end = data.maxMonth;
  }

  return { start: `${selectedYear}-01`, end, label: `${selectedYear}` };
}

function getSelectedCustomRange(data) {
  const rawStart = startMonthInput.value || data.minMonth;
  const rawEnd = endMonthInput.value || data.maxMonth;
  const start = clampMonthValue(rawStart, data.minMonth, data.maxMonth, data.minMonth);
  const end = clampMonthValue(rawEnd, data.minMonth, data.maxMonth, data.maxMonth);
  return start <= end
    ? { start, end, label: `${formatMonthLabel(start)} – ${formatMonthLabel(end)}` }
    : { start: end, end: start, label: `${formatMonthLabel(end)} – ${formatMonthLabel(start)}` };
}

function getSelectedMonthRange(data) {
  if (customRangeActive) return getSelectedCustomRange(data);
  return getSelectedYearRange(data);
}

function toggleFilterPanel(forceOpen) {
  const open = forceOpen ?? filterPanel.hidden;
  filterPanel.hidden = !open;
  filterButton.setAttribute('aria-expanded', String(open));
}

function renderSelectedRange() {
  if (!latestDashboardData) return;
  const range = getSelectedMonthRange(latestDashboardData);
  const monthKeys = iterMonthKeys(range.start, range.end);
  const series = normalizeSeries(monthKeys.map((month) => makeMonthRow(month, latestDashboardData.monthly[month])));
  renderChart(series);

  if (!series.length) {
    statusMessage.textContent = `No in-field/pre-delivery claims found for ${range.label}.`;
    return;
  }

  const prefix = customRangeActive
    ? 'Showing selected range'
    : yearSelect.value
      ? 'Showing selected year'
      : 'Showing latest 2 years';
  statusMessage.textContent = `${prefix}: ${formatMonthLabel(range.start)} to ${formatMonthLabel(range.end)}. Matched ${latestDashboardData.matchedTicketCount || 0} tickets since ${START_YEAR}.`;
}

async function refreshDashboard() {
  statusMessage.textContent = 'Refreshing Firebase tickets…';
  setLoading(true);
  try {
    latestDashboardData = await fetchDashboardData();
    syncControls(latestDashboardData);
    renderSelectedRange();
    lastUpdated.textContent = formatSyncText(latestDashboardData.latestSyncAt);
  } catch (error) {
    console.error(error);
    statusMessage.textContent = error.message;
    lastUpdated.textContent = 'Refresh failed';
  } finally {
    setLoading(false);
  }
}

filterButton.addEventListener('click', () => toggleFilterPanel());
yearSelect.addEventListener('change', () => {
  customRangeActive = false;
  toggleFilterPanel(false);
  renderSelectedRange();
});
applyFilterButton.addEventListener('click', () => {
  customRangeActive = true;
  toggleFilterPanel(false);
  renderSelectedRange();
});
last12Button.addEventListener('click', () => {
  if (!latestDashboardData) return;
  startMonthInput.value = addMonths(latestDashboardData.maxMonth, -11) < latestDashboardData.minMonth ? latestDashboardData.minMonth : addMonths(latestDashboardData.maxMonth, -11);
  endMonthInput.value = latestDashboardData.maxMonth;
  customRangeActive = true;
  toggleFilterPanel(false);
  renderSelectedRange();
});
clearFilterButton.addEventListener('click', () => {
  customRangeActive = false;
  toggleFilterPanel(false);
  renderSelectedRange();
});
refreshButton.addEventListener('click', refreshDashboard);
refreshDashboard();
window.setInterval(refreshDashboard, AUTO_REFRESH_MS);
