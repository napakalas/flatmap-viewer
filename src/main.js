/******************************************************************************

Flatmap viewer and annotation tool

Copyright (c) 2019  David Brooks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

******************************************************************************/

'use strict';

//==============================================================================

import { MapManager } from './flatmap-viewer';
export { MapManager };

//==============================================================================

export async function standaloneViewer(map_endpoint=null, map_options={})
{
    const requestUrl = new URL(window.location.href);
    if (map_endpoint == null) {
        const parts = requestUrl.pathname.split('/');
        map_endpoint = requestUrl.origin + (parts.slice(0, (parts[parts.length - 1] === '') ? -2 : -1)
                                            .concat([''])
                                            .join('/'));
    }

    const mapManager = new MapManager(map_endpoint, {
        images: [
            {
                id: 'label-background',
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC8AAAAmCAIAAADbSlUzAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAJOgAACToAYJjBRwAAACVSURBVFhH7dixDoJAEIThfXqMBcYKrTQ+jkYSStDYkVhZINxyEshJcZXJtC7FfNlmur9eyXb7Vqf6+bI9HUKyWkt5e4RlOF9ycerjsqbqpfefuKzNJawBWIOxBmMNxhqMNRhrMNZgrMFYg7EGYw3GGow1GGuw5dU07y4ua22nUlb3uKxd80IOx1Pjxp+f4P/P+ZButl+YrbXnPs+YmAAAAABJRU5ErkJggg==',
                options: {
                    content: [21, 4, 28, 33],
                    stretchX: [[21, 28]],
                    stretchY: [[4, 33]]
                }
            }
        ]
    });

    let currentMap = null;

    function loadMap(id, taxon)
    //=========================
    {
        if (currentMap !== null) {
            currentMap.close();
        }

        if (id !== null) {
            requestUrl.searchParams.set('id', id);
            requestUrl.searchParams.delete('taxon');
        } else if (taxon !== null) {
            id = taxon;
            requestUrl.searchParams.set('taxon', taxon);
            requestUrl.searchParams.delete('id');
        }
        window.history.pushState('data', document.title, requestUrl);

        const options = Object.assign({
            tooltips: true,
            background: '#EEF',
            debug: false,
            minimap: false,
            navigationControl: 'top-right',
            searchable: true,
            featureInfo: true
        }, map_options);

        mapManager.loadMap(id, 'map-canvas', (...args) => console.log(...args), options)
            .then(map => {
                map.addMarker('UBERON:0000948'); // Heart
                map.addMarker('UBERON:0002048'); // Lung
                map.addMarker('UBERON:0000945'); // Stomach
                map.addMarker('UBERON:0001155'); // Colon
                map.addMarker('UBERON:0001255'); // Bladder
                currentMap = map;
            })
            .catch(error => {
                console.log(error);
                alert(error);
            });
    }

    const viewMapId = requestUrl.searchParams.get('id');
    const viewMapTaxon = requestUrl.searchParams.get('taxon');

    let mapId = null;
    let mapTaxon = null;
    const latestMaps = new Map();
    const maps = await mapManager.allMaps();
    for (const map of Object.values(maps)) {
        const text = [];
        if ('describes' in map) {
            text.push(map.describes);
        }
        if ('name' in map) {
            text.push(map.name);
        } else {
            text.push(map.id);
        }
        const mapName = text.join(' -- ')
        if (!latestMaps.has(mapName)) {
            latestMaps.set(mapName, map);
        } else if (latestMaps.get(mapName).created < map.created) {
            latestMaps.set(mapName, map);
        }
    }
    // Sort in created order with most recent first
    const sortedMaps = new Map([...latestMaps].sort((a, b) => (a[1].created < b[1].created) ? 1
                                                            : (a[1].created > b[1].created) ? -1
                                                            : 0));
    const options = [];
    for (const [name, map] of sortedMaps.entries()) {
        const text = [ name, map.created ];
        let selected = '';
        if (mapId === null && map.id === viewMapId) {
            mapId = map.id;
            selected = 'selected';
        } else if (mapId === null && mapTaxon === null && map.describes === viewMapTaxon) {
            mapTaxon = viewMapTaxon;
            selected = 'selected';
        }
        options.push(`<option value="${map.id}" ${selected}>${text.join(' -- ')}</option>`);
    }
    options.splice(0, 0, '<option value="">Select flatmap...</option>');

    const selector = document.getElementById('map-selector');
    selector.innerHTML = options.join('');
    selector.onchange = (e) => {
        if (e.target.value !== '') {
            loadMap(e.target.value);
        }
    }

    if (mapId == null) {
        mapId = viewMapId;
    }
    if (mapTaxon == null) {
        mapTaxon = viewMapTaxon;
    }
    if (mapId === null && mapTaxon == null) {
        mapId = selector.options[1].value;
        selector.options[1].selected = true;
    }

    loadMap(mapId, mapTaxon);
}
