import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PropagationMap } from './PropagationMap';
import type { MapData } from '@/lib/map/query';
import type { MapPoint } from '@/lib/map/points';

const loadMapDataMock = vi.fn<() => Promise<MapData>>();
vi.mock('@/lib/map/query', () => ({
  loadMapData: () => loadMapDataMock(),
}));

// jsdom has no WebGL — stub the maplibre default export with no-op classes.
const markerInstances: { lngLat: [number, number] | null; removed: boolean }[] = [];
const mapRemove = vi.fn();
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('maplibre-gl', () => {
  class FakeMap {
    addControl() {
      return this;
    }
    on() {
      return this;
    }
    remove() {
      mapRemove();
    }
    addSource() {}
    addLayer() {}
  }
  class FakePopup {
    setHTML() {
      return this;
    }
    setDOMContent() {
      return this;
    }
  }
  class FakeMarker {
    private rec: { lngLat: [number, number] | null; removed: boolean };
    constructor() {
      this.rec = { lngLat: null, removed: false };
      markerInstances.push(this.rec);
    }
    setLngLat(ll: [number, number]) {
      this.rec.lngLat = ll;
      return this;
    }
    setPopup() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.rec.removed = true;
    }
  }
  class FakeNavigationControl {}
  return {
    default: {
      Map: FakeMap,
      Popup: FakePopup,
      Marker: FakeMarker,
      NavigationControl: FakeNavigationControl,
    },
  };
});

const POINTS: MapPoint[] = [
  {
    type: 'transmitter',
    id: 't1',
    name: 'Andrews HFGCS',
    lat: 38.81,
    lon: -76.87,
    meta: { callsign: 'ADW', frequencyKhzList: [11175, 8992], notes: 'primary' },
  },
  {
    type: 'sdr',
    id: 's1',
    name: 'KX0ABC',
    lat: 40,
    lon: -105,
    meta: { granularity: 'CITY', notes: null },
  },
];

describe('PropagationMap', () => {
  beforeEach(() => {
    loadMapDataMock.mockReset();
    markerInstances.length = 0;
    mapRemove.mockReset();
    loadMapDataMock.mockResolvedValue({
      points: POINTS,
      transmitterCount: 1,
      sdrCount: 1,
    });
  });

  it('renders the accessible data table with all plotted points', async () => {
    render(<PropagationMap />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // header + 2 data rows
    expect(rows).toHaveLength(3);
    expect(within(table).getByText('Andrews HFGCS')).toBeInTheDocument();
    expect(within(table).getByText('KX0ABC')).toBeInTheDocument();
    // frequencies + callsign surfaced in details
    expect(within(table).getByText(/11175 kHz/)).toBeInTheDocument();
    expect(within(table).getByText(/Callsign ADW/)).toBeInTheDocument();
    // SDR granularity surfaced
    expect(within(table).getByText(/city-level/)).toBeInTheDocument();
  });

  it('gives the map canvas an accessible label', async () => {
    render(<PropagationMap />);
    await screen.findByRole('table');
    expect(screen.getByRole('application', { name: /HF propagation map/i })).toBeInTheDocument();
  });

  it('hides transmitter rows when the transmitter layer is toggled off', async () => {
    render(<PropagationMap />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Andrews HFGCS')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Transmitters'));

    await waitFor(() => {
      expect(within(table).queryByText('Andrews HFGCS')).not.toBeInTheDocument();
    });
    // SDR still present
    expect(within(table).getByText('KX0ABC')).toBeInTheDocument();
  });

  it('hides SDR rows when the SDR layer is toggled off', async () => {
    render(<PropagationMap />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('KX0ABC')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Public SDRs'));

    await waitFor(() => {
      expect(within(table).queryByText('KX0ABC')).not.toBeInTheDocument();
    });
    expect(within(table).getByText('Andrews HFGCS')).toBeInTheDocument();
  });

  it('plots a marker per point once the map initializes', async () => {
    render(<PropagationMap />);
    await screen.findByRole('table');
    await waitFor(() => {
      const live = markerInstances.filter((m) => !m.removed);
      expect(live).toHaveLength(2);
    });
    // markers use [lon, lat] order
    const lngLats = markerInstances.map((m) => m.lngLat);
    expect(lngLats).toContainEqual([-76.87, 38.81]);
    expect(lngLats).toContainEqual([-105, 40]);
  });

  it('shows an error state when the data load fails', async () => {
    loadMapDataMock.mockRejectedValue(new Error('boom'));
    render(<PropagationMap />);
    expect(await screen.findByText(/Could not load map data/i)).toBeInTheDocument();
  });

  it('escapes HTML injection attempts in the accessible table', async () => {
    const maliciousPoints: MapPoint[] = [
      {
        type: 'transmitter',
        id: 't-injection',
        name: '<img src=x onerror="alert(1)">',
        lat: 0,
        lon: 0,
        meta: { callsign: '";DROP--', frequencyKhzList: null, notes: "';alert(2)//" },
      },
    ];
    loadMapDataMock.mockResolvedValue({
      points: maliciousPoints,
      transmitterCount: 1,
      sdrCount: 0,
    });
    render(<PropagationMap />);
    const table = await screen.findByRole('table');
    // Verify malicious strings appear escaped as plain text (not as markup)
    const nameCell = within(table).getByText('<img src=x onerror="alert(1)">');
    expect(nameCell).toBeInTheDocument();
    // Ensure content is in text, not parsed as HTML
    expect(nameCell.innerHTML).toBe('&lt;img src=x onerror="alert(1)"&gt;');
  });
});
