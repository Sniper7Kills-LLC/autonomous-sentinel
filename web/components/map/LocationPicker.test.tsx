import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LocationPicker } from './LocationPicker';

/**
 * Tests for the `LocationPicker` component (#785).
 *
 * Covers:
 *   - SSR placeholder renders correctly (no map in jsdom)
 *   - after mount, map host renders
 *   - coords display updates on click
 *   - initial coords shown when provided
 *   - onChange callback fires with rounded coords
 */

// jsdom has no WebGL — stub maplibre with a minimal fake
let clickHandler: ((e: { lngLat: { lat: number; lng: number } }) => void) | null = null;
let dragEndHandler: (() => void) | null = null;
let markerLngLat: [number, number] | null = null;
let markerAddedToMap = false;

const fakeDragEndTarget = {
  on: (event: string, fn: () => void) => {
    if (event === 'dragend') dragEndHandler = fn;
    return fakeDragEndTarget;
  },
  getLngLat: () => ({ lat: markerLngLat?.[1] ?? 0, lng: markerLngLat?.[0] ?? 0 }),
  setLngLat: (ll: [number, number]) => {
    markerLngLat = ll;
    return fakeDragEndTarget;
  },
  addTo: () => {
    markerAddedToMap = true;
    return fakeDragEndTarget;
  },
  remove: () => fakeDragEndTarget,
  _map: null as unknown,
};

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('maplibre-gl', () => {
  class FakeMap {
    addControl() {
      return this;
    }
    on(event: string, fn: (e: { lngLat: { lat: number; lng: number } }) => void) {
      if (event === 'click') clickHandler = fn;
      return this;
    }
    remove() {}
  }
  class FakeMarker {
    draggable: boolean;
    constructor(_opts: { draggable?: boolean; color?: string } = {}) {
      this.draggable = _opts.draggable ?? false;
      markerLngLat = null;
      markerAddedToMap = false;
    }
    on(event: string, fn: () => void) {
      if (event === 'dragend') dragEndHandler = fn;
      return this;
    }
    getLngLat() {
      return { lat: markerLngLat?.[1] ?? 0, lng: markerLngLat?.[0] ?? 0 };
    }
    setLngLat(ll: [number, number]) {
      markerLngLat = ll;
      return this;
    }
    addTo() {
      markerAddedToMap = true;
      return this;
    }
    remove() {}
    _map = null;
  }
  class FakeNavigationControl {}
  return {
    default: {
      Map: FakeMap,
      Marker: FakeMarker,
      NavigationControl: FakeNavigationControl,
    },
  };
});

describe('LocationPicker component (#785)', () => {
  beforeEach(() => {
    clickHandler = null;
    dragEndHandler = null;
    markerLngLat = null;
    markerAddedToMap = false;
  });

  it('renders without crashing with no initial coords', () => {
    const onChange = vi.fn();
    render(<LocationPicker latitude={null} longitude={null} onChange={onChange} />);
    // After mount, the map host div should be in the document
    expect(screen.getByRole('application')).toBeInTheDocument();
  });

  it('shows "Click the map to set a location" when no coords', async () => {
    const onChange = vi.fn();
    render(<LocationPicker latitude={null} longitude={null} onChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByText('Click the map to set a location')).toBeInTheDocument();
    });
  });

  it('shows initial coordinates when provided', async () => {
    const onChange = vi.fn();
    render(<LocationPicker latitude={37.774929} longitude={-122.419416} onChange={onChange} />);
    await waitFor(() => {
      expect(screen.getByText(/37\.774929/)).toBeInTheDocument();
      expect(screen.getByText(/-122\.419416/)).toBeInTheDocument();
    });
  });

  it('calls onChange with rounded coords when map is clicked', async () => {
    const onChange = vi.fn();
    render(<LocationPicker latitude={null} longitude={null} onChange={onChange} />);

    await waitFor(() => {
      expect(clickHandler).not.toBeNull();
    });

    // Simulate a map click
    clickHandler!({ lngLat: { lat: 40.123456789, lng: -75.987654321 } });

    expect(onChange).toHaveBeenCalledWith(40.123457, -75.987654);
  });

  it('updates displayed coords after map click', async () => {
    const onChange = vi.fn();
    render(<LocationPicker latitude={null} longitude={null} onChange={onChange} />);

    await waitFor(() => {
      expect(clickHandler).not.toBeNull();
    });

    clickHandler!({ lngLat: { lat: 51.5074, lng: -0.1278 } });

    await waitFor(() => {
      expect(screen.getByText(/51\.507400/)).toBeInTheDocument();
      expect(screen.getByText(/-0\.127800/)).toBeInTheDocument();
    });
  });

  it('has accessible role=application on the map host', () => {
    const onChange = vi.fn();
    render(<LocationPicker latitude={null} longitude={null} onChange={onChange} />);
    const mapEl = screen.getByRole('application');
    expect(mapEl).toHaveAttribute(
      'aria-label',
      'Location picker map — click or drag the marker to set a location',
    );
  });

  it('accepts an optional label prop', async () => {
    const onChange = vi.fn();
    render(
      <LocationPicker
        latitude={null}
        longitude={null}
        onChange={onChange}
        label="SDR Location"
      />,
    );
    expect(screen.getByText('SDR Location')).toBeInTheDocument();
  });

  it('coords display is aria-live for screen reader updates', () => {
    const onChange = vi.fn();
    render(<LocationPicker latitude={null} longitude={null} onChange={onChange} />);
    const coordsEl = screen.getByText('Click the map to set a location');
    expect(coordsEl).toHaveAttribute('aria-live', 'polite');
  });
});
