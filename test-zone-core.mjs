import assert from 'node:assert/strict';
import {
  featureCode, featureName, featureType, isResidentZone,
  parseWKT, recordsToFeatures, residentFeatures,
  geometryContains, findZone
} from './zone-core.js';

const resident = {
  type: 'Feature',
  properties: { ZONETYPE: 'Beboerzone', ZONEKODE: 'VB', ZONENAVN: 'Vesterbro' },
  geometry: { type: 'Polygon', coordinates: [[[12,55],[13,55],[13,56],[12,56],[12,55]]] }
};
assert.equal(featureCode(resident), 'VB');
assert.equal(featureName(resident), 'Vesterbro');
assert.equal(featureType(resident), 'Beboerzone');
assert.equal(isResidentZone(resident), true);
assert.equal(isResidentZone({ ...resident, properties: { ZONETYPE: 'Adressebeboerzone', ZONEKODE: 'VB' } }), false);

assert.equal(geometryContains([12.5,55.5], resident.geometry), true);
assert.equal(geometryContains([13.5,55.5], resident.geometry), false);
assert.equal(findZone([resident], 55.5, 12.5), resident);

const hole = { type: 'Polygon', coordinates: [
  [[0,0],[10,0],[10,10],[0,10],[0,0]],
  [[4,4],[6,4],[6,6],[4,6],[4,4]]
]};
assert.equal(geometryContains([2,2], hole), true);
assert.equal(geometryContains([5,5], hole), false);

const multi = { type: 'MultiPolygon', coordinates: [
  [[[0,0],[1,0],[1,1],[0,1],[0,0]]],
  [[[10,10],[11,10],[11,11],[10,11],[10,10]]]
]};
assert.equal(geometryContains([10.5,10.5], multi), true);

const wkt = parseWKT('POLYGON ((12 55, 13 55, 13 56, 12 56, 12 55))');
assert.equal(wkt.type, 'Polygon');
assert.equal(wkt.coordinates[0][0][0], 12);

const wrapped = { data: { type: 'FeatureCollection', features: [resident] } };
assert.equal(residentFeatures(wrapped).length, 1);

const legacy = { result: { records: [{ zonetype: 'Beboerzone', zonekode: 'IN', geometry: 'POLYGON ((12 55,13 55,13 56,12 56,12 55))' }] } };
assert.equal(recordsToFeatures(legacy).length, 1);
assert.equal(residentFeatures(legacy)[0].properties.zonekode, 'IN');

// Schema-change fallback: unknown property keys, but recognizable values.
const oddSchema = {
  type: 'Feature',
  properties: { a: 'Beboerzone', b: 'YØ', c: 'Ydre Østerbro' },
  geometry: resident.geometry
};
assert.equal(isResidentZone(oddSchema), true);
assert.equal(featureCode(oddSchema), 'YØ');

console.log('zone-core: alle tests bestået');
