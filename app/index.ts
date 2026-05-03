/******************************************************************************

Flatmap viewer and annotation tool

Copyright (c) 2019 - 2025 David Brooks

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


import type {DrawControl, DrawEvent} from './annotator'
import {PaneManager} from './multipane'

//import { DATASETS } from './datasets'

import { type FlatMap, type FlatMapOptions, MapViewer } from '../lib'

//==============================================================================

const MAX_VIEWER_PANES = 1 // 3

const VIEWER_CANVAS = 'flatmap-viewer-canvas'

const PROVENANCE_DISPLAY = false

//==============================================================================

const DEBUG = false;
const MINIMAP = false; // { width: '10%', background: '#FCC' };

const MAP_ENDPOINTS = {
    huggingface: 'https://napakalas-flatmap-demo.hf.space/',
    local: 'http://localhost:8000',
    curation: 'https://mapcore-demo.org/curation/flatmap/',
    devel: 'https://mapcore-demo.org/devel/flatmap/v4/',
    fccb: 'https://mapcore-demo.org/fccb/flatmap/',
    production: 'https://mapcore-demo.org/current/flatmap/v3/',
    staging: 'https://mapcore-demo.org/staging/flatmap/v1/',
}

const DEFAULT_OPTIONS = {
    debug: false,
    minimap: true,
    showId: false,
    showCoords: false,
    showLngLat: false,
    standalone: true,
    flightPaths: false,
    maxZoom: 12.99
}

window.onload = () => {
    standaloneViewer(MAP_ENDPOINTS, {
        debug: DEBUG,
        minimap: MINIMAP
    })
}

//==============================================================================

export async function standaloneViewer(mapEndpoints={}, options={})
//=================================================================
{
    const viewer = new StandaloneViewer(mapEndpoints, options)

    // Everything setup so start by loading a map from a map server

    await viewer.loadMapList()
}

//==============================================================================

const keyPrompts = [
    ['id', 'Map Id'],
    ['uuid', 'Map UUID'],
    ['name', 'Name'],
    ['describes', 'Describes'],
    ['taxon', 'Taxon Id'],
    ['biological-sex', 'Biological sex'],
    ['created', 'Created'],
    ['creator', 'Created by'],
    ['source', 'Map source'],
    ['git-status', 'Git'],
    ['server', 'Map server'],
    ['sckan', 'SCKAN release'],
    ['connectivity', 'SCKAN connectivity']
]

function fieldAsHtml(dict, level, sckan=false): string
//====================================================
{
    const html: string[] = []
    for (const key of Object.keys(dict)) {
        let value = dict[key]
        if (value instanceof Object && value.constructor === Object) {
            value = fieldAsHtml(value, level + 1, sckan)
        }
        const prompt = (sckan && key==='date') ? 'Version' : key.at(0).toUpperCase() + key.slice(1)
        html.push(`<div class="info"><span class="prompt">${'<span class="spacer">&nbsp;</span>'.repeat(level)}${prompt}:</span> ${value}</div>`)
    }
    return html.join('\n')
}

function provenanceAsHtml(dict): string
//=====================================
{
    const mapServer = dict.server || null
    const mapID = dict.uuid || dict.id || null

    const html: string[] = []
    for (const [key, prompt] of keyPrompts) {
        if (key in dict) {
            let value = dict[key]
            if (value instanceof Object && value.constructor === Object) {
                value = fieldAsHtml(value, 1, (key==='connectivity'))
            } else if (key === 'created') {
                if (mapServer && mapID) {
                    value = `${value}&nbsp;&nbsp;<a target="_blank" href="${mapServer}/flatmap/${mapID}/log">Log file</a>`
                }
            }
            html.push(`<div class='info outermost'><span class="prompt">${prompt}:</span>&nbsp;${value}</div>`)
        }
    }
    return html.join('\n')
}

//==============================================================================

class StandaloneViewer
{
    #currentMap: FlatMap|null = null
    #currentServer: string|null
    #currentViewer: MapViewer|null = null
    #defaultBackground: string = localStorage.getItem('flatmap-background-colour') || 'black'
    #drawControl: DrawControl|null = null

    #mapEndpoints: object
    #mapSelector: HTMLSelectElement
    #mapGeneration: HTMLSelectElement
    #mapOptions: FlatMapOptions
    #mapProvenance: HTMLElement

    #mapIdToName = new Map()
    #mapGenerations = new Map()

    #mapId: string|null = null
    #mapSex: string|null = null
    #mapTaxon: string|null = null
    #paneManager: PaneManager
    #requestUrl: URL

    #viewMapId: string|null = null
    #viewMapSex: string|null = null
    #viewMapTaxon: string|null = null

    #mm: boolean = true

    constructor(mapEndpoints={}, options={})
    {
        this.#mapEndpoints = mapEndpoints
        this.#mapOptions = Object.assign({}, DEFAULT_OPTIONS, {background: this.#defaultBackground}, options)

        this.#requestUrl = new URL(window.location.href)
        const requestPathParts = this.#requestUrl.pathname.split('/')
        const requestEndpoint = this.#requestUrl.origin + (requestPathParts.slice(0, (requestPathParts[requestPathParts.length - 1] === '') ? -2 : -1)
                                                                     .concat([''])
                                                                     .join('/'))
        this.#currentServer = this.#requestUrl.searchParams.get('server') || null
        if (this.#currentServer && !this.#mapEndpoints[this.#currentServer]) {
            this.#currentServer = null
        }
        if (this.#currentServer === null) {
            if (requestEndpoint.includes('localhost')) {
                if ('local' in this.#mapEndpoints) {
                    // localhost is a special case since viewer might be separate
                    this.#currentServer = 'local'
                }
            } else {
                // Running remotely so don't confuse the user...
                if ('local' in this.#mapEndpoints) {
                    delete this.#mapEndpoints.local
                }
                for (const [server, endpoint] of Object.entries(this.#mapEndpoints)) {
                    if (endpoint === requestEndpoint) {
                        this.#currentServer = server
                        break
                    }
                }
                if (this.#currentServer === null) {
                    this.#currentServer = 'default'
                    this.#mapEndpoints[this.#currentServer] = requestEndpoint
                }
            }
        }
        if (Object.keys(this.#mapEndpoints).length <= 1) {
            // Don't allow server selection if there's just a single server
            // biome-ignore lint/style/noNonNullAssertion: we have a `server-selection` element
            document.getElementById('server-selection')!.hidden = true
        } else {
            const mapServerList: string[] = []
            for (const [server, endpoint] of Object.entries(this.#mapEndpoints)) {
                const selected = (server === this.#currentServer) ? 'selected' : ''
                mapServerList.push(`<option value="${server}" ${selected}>${server} -- ${endpoint}</option>`)
            }
            mapServerList.splice(0, 0, '<option value="">Select flatmap server...</option>')
            const serverSelector = document.getElementById('server-selector') as HTMLSelectElement
            serverSelector.innerHTML = mapServerList.join('')
            serverSelector.onchange = async (e) => {
                const value = (<HTMLSelectElement>e.target).value
                if (value !== '') {
                    this.changeMapServer(value)
                    await this.loadMapList()
                }
            }
        }

        this.#viewMapId = this.#requestUrl.searchParams.get('id')
        this.#viewMapTaxon = this.#requestUrl.searchParams.get('taxon')
        this.#viewMapSex = this.#requestUrl.searchParams.get('sex')

        this.#mapSelector = document.getElementById('map-selector') as HTMLSelectElement
        this.#mapGeneration = document.getElementById('map-generation') as HTMLSelectElement
        this.#mapProvenance = document.getElementById('provenance-display') as HTMLElement
        this.#paneManager = new PaneManager(VIEWER_CANVAS, MAX_VIEWER_PANES)

        this.changeMapServer(this.#currentServer)
    }

    changeMapServer(server: string|null)
    //==================================
    {
        if (server === null) {
            return
        }
        if (this.#currentMap) {
            this.#currentMap.close()
        }
        this.#currentViewer = new MapViewer(this.#mapEndpoints[server], {
            container: '',
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
        })
        this.#currentServer = server
        this.#mapId = null
        this.#mapTaxon = null
        this.#mapSex = null
    }

    async loadMapList()
    //=================
    {
        // biome-ignore lint/style/noNonNullAssertion: we have a viewer
        await this.setMapList(this.#currentViewer!)
    }

    async setMapList(viewer: MapViewer)
    //=================================
    {
        this.#mapIdToName.clear()
        this.#mapGenerations.clear()
        const latestMaps = new Map()
        const maps = await viewer.allMaps()
        for (const map of Object.values(maps)) {
            const text: string[] = []
            if (map.describes) {
                text.push(map.describes)
            }
            text.push(map.name || map.id)
            const mapName = text.join(' -- ')
            if (!latestMaps.has(mapName)) {
                latestMaps.set(mapName, map)
            } else if (latestMaps.get(mapName).created < map.created) {
                latestMaps.set(mapName, map)
            }
            const id = ('uuid' in map) ? map.uuid : map.id
            this.#mapIdToName.set(id, mapName)
            if (!this.#mapGenerations.has(mapName)) {
                this.#mapGenerations.set(mapName, [map])
            } else {
                this.#mapGenerations.get(mapName).push(map)
            }
        }

        // The name of the map being viewed
        const viewName = this.#mapIdToName.get(this.#viewMapId)

        // Sort maps into name order
        const sortedMaps = new Map([...latestMaps]
                                .sort((a, b) => Intl.Collator().compare(a[0], b[0])))
        const mapList: string[] = []
        for (const [name, map] of sortedMaps.entries()) {
            // Sort generations into created order with most recent first
            const reverseDateOrder = this.#mapGenerations.get(name)
                                            .sort((a, b) => (a.created < b.created) ? 1
                                                          : (a.created > b.created) ? -1
                                                          : 0)
            this.#mapGenerations.set(name, reverseDateOrder)
            const id = ('uuid' in map) ? map.uuid : map.id
            if (this.#mapId === null && id === this.#viewMapId) {
                this.#mapId = id
            } else if (this.#mapId === null
                    && this.#mapTaxon === null
                    && map.taxon === this.#viewMapTaxon
                    && !('biologicalSex' in map || map.biologicalSex === this.#viewMapSex)) {
                this.#mapTaxon = this.#viewMapTaxon
                this.#mapSex = this.#viewMapSex
            }
            const selected = (name === viewName) ? 'selected' : ''
            mapList.push(`<option value="${id}" ${selected}>${name}</option>`)
        }
        mapList.splice(0, 0, '<option value="">Select flatmap...</option>')

        this.#mapSelector.innerHTML = mapList.join('')
        this.#mapSelector.onchange = async (e) => {
            const value = (<HTMLSelectElement>e.target).value
            if (value !== '') {
                this.setGenerationSelector(value)
                await this.loadMap(this.#currentViewer!, value)
            }
        }
        this.#mapGeneration.onchange = async (e: Event) => {
            const value = (<HTMLSelectElement>e.target).value
            if (value !== '') {
                await this.loadMap(this.#currentViewer!, value)
            }
        }

        this.#mapId ||= this.#viewMapId
        this.#mapTaxon ||= this.#viewMapTaxon
        this.#mapSex ||= this.#viewMapSex
        if (!(this.#mapId || this.#mapTaxon)) {
            this.#mapId = this.#mapSelector.options[1].value
            this.#mapSelector.options[1].selected = true
        }

        this.setGenerationSelector(this.#mapId!)
        await this.loadMap(this.#currentViewer!, this.#mapId!, this.#mapTaxon, this.#mapSex)
    }

    setGenerationSelector(mapId: string)
    //==================================
    {
        const generationList: string[] = []
        const mapName = this.#mapIdToName.get(mapId)
        if (mapName) {
            for (const map of this.#mapGenerations.get(mapName)) {
                const id = ('uuid' in map) ? map.uuid : map.id
                const selected = (mapId === id) ? 'selected' : ''
                generationList.push(`<option value="${id}" ${selected}>${map.created}</option>`)
            }
        }
        this.#mapGeneration.innerHTML = generationList.join('')
    }

    async loadMap(viewer: MapViewer, id: string, taxon: string|null=null, sex: string|null=null)
    //==========================================================================================
    {
        this.#mapProvenance.innerHTML = ''
        if (id !== null) {
            this.#requestUrl.searchParams.set('id', id)
            this.#requestUrl.searchParams.delete('taxon')
            this.#requestUrl.searchParams.delete('sex')
        } else if (taxon !== null) {
            id = taxon
            this.#requestUrl.searchParams.set('taxon', taxon)
            if (sex !== null) {
                this.#requestUrl.searchParams.set('sex', sex)
            }
            this.#requestUrl.searchParams.delete('id')
        }
        // biome-ignore lint/style/noNonNullAssertion: we have a server
        this.#requestUrl.searchParams.set('server', this.#currentServer!)

        // Update address bar URL to current map
        window.history.pushState('data', document.title, this.#requestUrl)

        await this.#paneManager.loadMap(viewer, id, this.mapCallback.bind(this), this.#mapOptions)
        .then(map => {
            if (map) {
                this.#currentMap = map
                if (this.#mapProvenance && PROVENANCE_DISPLAY) {
                    this.#mapProvenance.style.display = 'block'
                    // biome-ignore lint/style/noNonNullAssertion: we have a server
                    this.#mapProvenance.innerHTML = provenanceAsHtml(Object.assign({server: this.#mapEndpoints[this.#currentServer!]},
                                                                     map.mapMetadata))
                }
                map.addMarkers([
                    'cvs:functional.whole-body',
                    'cvs:functional.tissue',
                    'cvs:functional.cell'
                ], {kind: 'multiscale'})
//                map.setPaint({ coloured: false, outlined: false })

//                console.log(map.flatmapLegend)

                console.log(map.mapMetadata)

//                map.addDatasetMarkers([{id: '6', terms: ['UBERON:0018683']}]) // lumbar splanchnic nerve

//                console.log('Stomach marker:', map.addMarker('UBERON:0000945'))  // stomach

//                map.addDatasetMarkers([{id: '1', terms: ['UBERON:0000945']}])   // stomach
//                map.addDatasetMarkers([{id: '2', terms: ['UBERON:0002113']}])   // kidney
//                map.addDatasetMarkers([{id: '6', terms: ['UBERON:0000948']}])   // heart
                //map.addDatasetMarkers(DATASETS)

                for (const dataset of DATASETS) {
                    if (dataset.terms.length) {
                        map.addDatasetMarkers([dataset])
                    }
                }

/****************
                //map.addDatasetMarkers([{id: '1', terms: ['UBERON:0001759']}])   // vagus
                map.addDatasetMarkers([{id: '6', terms: ['UBERON:0000948']}])   // heart
                map.addDatasetMarkers([{id: '2', terms: ['UBERON:0000044']}])   // DRG
                //map.addDatasetMarkers([{id: '3', terms: ['UBERON:0000045']}])   // Ganglion
                //map.addDatasetMarkers([{id: '4', kind: 'multiscale', terms: ['UBERON:0003943']}])   // L4 DRG
                map.addDatasetMarkers([{id: '5', terms: ['UBERON:0018675']}])   // Pelvic splanchnic nerve

                map.addDatasetMarkers([{id: '1', terms: ['UBERON:0001199']}])  // mucosa of stomach
                map.addDatasetMarkers([{id: '2', terms: ['UBERON:0002113', 'UBERON:0002107']}]) // kidney, liver
                map.addDatasetMarkers([{id: '2', kind: 'multiscale', terms: ['UBERON:0002113']}]) // kidney, liver
***************/
            }
        })
        .catch(error => {
            console.log(error)
            alert(error)
        })
    }

    async mapCallback(eventType: string, data: Record<string, any>)
    //=============================================================
    {
        if (data.type === 'control' && data.control === 'background') {
            this.#mapOptions.background = data.value
            return true
        } else if (eventType === 'annotation') {
            if (this.#drawControl) {
                this.#drawControl.handleEvent(data as DrawEvent)
            }
            return true
        } else if (eventType === 'click') {
            console.log(eventType, data)

            this.#mm = !this.#mm
            if (this.#mm) {
//                this.#currentMap!.createMinimap()
            } else {
//                this.#currentMap!.closeMinimap()
            }
            if ('hyperlinks' in data) {
                if ('flatmap' in data.hyperlinks) {
                    // biome-ignore lint/style/noNonNullAssertion: we have a viewer
                    await this.#paneManager.loadMap(this.#currentViewer!, data.hyperlinks.flatmap,
                                                    this.mapCallback.bind(this), this.#mapOptions,
                                                    true)
                                            .then(map => {
                                                if (map) {
                                                    map.addMarkers([
                                                        'cvs:functional.whole-body',
                                                        'cvs:functional.tissue',
                                                        'cvs:functional.cell'
                                                    ], {kind: 'multiscale'})
                                                }
                                            })
                }
            }
            return true
        } else if (data.type === 'marker') {
            if (eventType === 'click') {
                console.log(eventType)
            }
            return true
        }
    }
}

//==============================================================================
