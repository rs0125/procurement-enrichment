// About 0.1 mm at the equator, far below the precision of warehouse geocoding.
export const COORDINATE_EPSILON = 1e-9;
export const sameCoordinates = (row, warehouse) => row?.computedFromLat != null && row?.computedFromLng != null
  && Math.abs(row.computedFromLat - warehouse.lat) <= COORDINATE_EPSILON
  && Math.abs(row.computedFromLng - warehouse.lng) <= COORDINATE_EPSILON;
