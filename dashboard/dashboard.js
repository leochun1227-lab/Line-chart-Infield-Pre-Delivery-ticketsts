const FIREBASE_DB_URL = 'https://snowy-hr-report-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_ROOT = 'c4cTickets_test';
const START_YEAR = 2024;
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const IN_FIELD_KEYWORDS = ['in field', 'in-field', 'infield', 'field warranty'];
const PRE_DELIVERY_KEYWORDS = ['pre delivery', 'pre-delivery', 'predelivery', 'pdi'];

const chartCanvas = document.getElementById('claimsChart');
const refreshButton = document.getElementById('refreshButton');
const yearSelect = document.getElementById('yearSelect');
const lastUpdated = document.getElementById('lastUpdated');
const statusMessage = document.getElementById('statusMessage');
let claimsChart;
let latestDashboardData = null;

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

  // Fallback for custom C4C/Firebase field names: include all scalar ticket values.
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

function getCurrentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function yearMonthKeys(year, latestDataMonth) {
  const current = getCurrentYearMonth();
  if (year > current.year) return [];
  let endMonth = 12;
  if (year === current.year) {
    endMonth = latestDataMonth || current.month;
    endMonth = Math.min(Math.max(endMonth, 1), current.month);
  }
  return Array.from({ length: endMonth }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`);
}

function normalizeSeries(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.month)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((row) => ({
      month: row.month,
      label: formatMonthLabel(row.month, row.label),
      inField: Number(row.inField || 0),
      preDelivery: Number(row.preDelivery || 0),
      total: Number(row.total || 0),
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

    // Count every Firebase ticket that matches in-field/pre-delivery claim text.
    // Do not read criticalRemovedDaily or filter by critical status.
    const bucket = classifyTicket(ticket);
    if (!bucket) {
      unmatchedTicketCount += 1;
      return;
    }

    // CreatedOn is the only date field used for the dashboard month.
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

  const current = getCurrentYearMonth();
  const latestMonthByYear = Object.keys(monthly).reduce((acc, monthKey) => {
    const year = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5, 7));
    acc[year] = Math.max(acc[year] || 0, month);
    return acc;
  }, {});
  const dataYears = Object.keys(monthly).map((month) => Number(month.slice(0, 4))).filter((year) => year >= START_YEAR);
  const maxYear = Math.max(current.year, ...dataYears, START_YEAR);
  const availableYears = Array.from({ length: maxYear - START_YEAR + 1 }, (_, index) => START_YEAR + index);
  const seriesByYear = Object.fromEntries(
    availableYears.map((year) => [
      String(year),
      yearMonthKeys(year, latestMonthByYear[year]).map((month) => {
        const inField = Number(monthly[month]?.inField || 0);
        const preDelivery = Number(monthly[month]?.preDelivery || 0);
        return {
          month,
          label: formatMonthLabel(month),
          inField,
          preDelivery,
          total: inField + preDelivery,
        };
      }),
    ]),
  );

  return {
    seriesByYear,
    availableYears,
    defaultYear: String(current.year),
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
          suggestedMax: Math.max(900, Math.ceil(maxValue / 100) * 100),
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

function getSelectedYear(data) {
  const currentYear = String(getCurrentYearMonth().year);
  const options = (data?.availableYears || []).map(String);
  if (yearSelect.value && options.includes(yearSelect.value)) return yearSelect.value;
  if (options.includes(currentYear)) return currentYear;
  return String(options[options.length - 1] || START_YEAR);
}

function syncYearSelect(data) {
  const years = data.availableYears || [START_YEAR];
  const selectedYear = getSelectedYear(data);
  yearSelect.innerHTML = years
    .map((year) => `<option value="${year}"${String(year) === selectedYear ? ' selected' : ''}>${year}</option>`)
    .join('');
  return selectedYear;
}

function renderSelectedYear() {
  if (!latestDashboardData) return;
  const selectedYear = getSelectedYear(latestDashboardData);
  yearSelect.value = selectedYear;
  const series = normalizeSeries(latestDashboardData.seriesByYear?.[selectedYear] || []);
  renderChart(series);

  if (!series.length) {
    statusMessage.textContent = `No ${selectedYear} in-field/pre-delivery claims found from ${latestDashboardData.source}.`;
    return;
  }

  const monthText = selectedYear === String(getCurrentYearMonth().year)
    ? `January to ${series[series.length - 1].label}`
    : 'January to December';
  statusMessage.textContent = `Showing ${selectedYear} (${monthText}) from all matching Firebase tickets. Matched ${latestDashboardData.matchedTicketCount || 0} tickets since ${START_YEAR}.`;
}

async function refreshDashboard() {
  refreshButton.disabled = true;
  statusMessage.textContent = 'Refreshing Firebase tickets…';
  try {
    latestDashboardData = await fetchDashboardData();
    syncYearSelect(latestDashboardData);
    renderSelectedYear();
    lastUpdated.textContent = formatSyncText(latestDashboardData.latestSyncAt);
  } catch (error) {
    console.error(error);
    statusMessage.textContent = error.message;
    lastUpdated.textContent = 'Refresh failed';
  } finally {
    refreshButton.disabled = false;
  }
}

yearSelect.addEventListener('change', renderSelectedYear);
refreshButton.addEventListener('click', refreshDashboard);
refreshDashboard();
window.setInterval(refreshDashboard, AUTO_REFRESH_MS);
