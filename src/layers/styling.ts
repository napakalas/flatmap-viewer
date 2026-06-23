/*==============================================================================

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

==============================================================================*/

import type {
    BackgroundLayerSpecification,
    ColorSpecification,
    DataDrivenPropertyValueSpecification,
    ExpressionFilterSpecification,
    ExpressionSpecification,
    ExpressionType,
    FillLayerSpecification,
    LineLayerSpecification,
    PropertyValueSpecification,
    RasterLayerSpecification,
    ResolvedImageSpecification,
    SymbolLayerSpecification
} from 'maplibre-gl'

//==============================================================================

export const VECTOR_TILES_SOURCE = 'vector-tiles'

//==============================================================================

import {FLATMAP_STYLE} from '../flatmap'
import {PATH_STYLE_RULES} from '../pathways'

import {FlatMapLayer, FlatMapLayerOptions} from '../flatmap-types'

//==============================================================================

export interface StyleLayerOptions extends FlatMapLayerOptions
{
    dashed?: boolean
    'detail-layer'?: boolean
    flatmapStyle?: FLATMAP_STYLE,
    highlight?: boolean
    'max-zoom'?: number
    'min-zoom'?: number
}

export interface StylingOptions extends StyleLayerOptions
{
    activeRasterLayer?: boolean
    excludeAnnotated?: boolean
    colour?: string
    dimmed?: boolean
    hasImageLayers?: boolean
    opacity?: number
    pathLowDensityMode?: boolean
    showNerveCentrelines?: boolean
}

//==============================================================================

const COLOUR_ACTIVE    = 'blue'
const COLOUR_ANNOTATED = '#C8F'
const COLOUR_SELECTED  = '#8EF35D'
const COLOUR_HIDDEN    = '#D8D8D8'

const CENTRELINE_ACTIVE = '#888'
const CENTRELINE_COLOUR = '#8FF'

const FEATURE_SELECTED_BORDER = 'black'

const NERVE_ACTIVE = 'blue'
const NERVE_SELECTED = 'black'

//==============================================================================

export function markerZoomScaling(expression: ExpressionSpecification|ExpressionType|number): DataDrivenPropertyValueSpecification<number> {
    return [
        'let', 'unscaled', expression,
        [
            'interpolate',
            ['exponential', 2],
            ['zoom'],
            2, ["*", ['var', 'unscaled'], ["^", 2, 0.5]],
            12, ["*", ['var', 'unscaled'], ["^", 2, 6]]
        ]
    ]
}

export function uniformZoomScaling(expression: ExpressionSpecification|ExpressionType|number): DataDrivenPropertyValueSpecification<number> {
    return [
        'let', 'unscaled', expression,
        [
            'interpolate',
            ['exponential', 2],
            ['zoom'],
            2, ["*", ['var', 'unscaled'], ["^", 2, -2]],
            12, ["*", ['var', 'unscaled'], ["^", 2, 8]]
        ]
    ]
}

//==============================================================================

// Raster layers of detailed maps gradually show
const DETAIL_ZOOM_OFFSET = 3

//==============================================================================

// MapLibre implied types

export type FillPaintSpecification = {
    "fill-antialias"?: PropertyValueSpecification<boolean>
    "fill-opacity"?: DataDrivenPropertyValueSpecification<number>
    "fill-color"?: DataDrivenPropertyValueSpecification<ColorSpecification>
    "fill-outline-color"?: DataDrivenPropertyValueSpecification<ColorSpecification>
    "fill-translate"?: PropertyValueSpecification<[
        number,
        number
    ]>
    "fill-translate-anchor"?: PropertyValueSpecification<"map" | "viewport">
    "fill-pattern"?: DataDrivenPropertyValueSpecification<ResolvedImageSpecification>
}

export type LinePaintSpecification = {
    "line-opacity"?: DataDrivenPropertyValueSpecification<number>
    "line-color"?: DataDrivenPropertyValueSpecification<ColorSpecification>
    "line-translate"?: PropertyValueSpecification<[
        number,
        number
    ]>;
    "line-translate-anchor"?: PropertyValueSpecification<"map" | "viewport">
    "line-width"?: DataDrivenPropertyValueSpecification<number>
    "line-gap-width"?: DataDrivenPropertyValueSpecification<number>
    "line-offset"?: DataDrivenPropertyValueSpecification<number>
    "line-blur"?: DataDrivenPropertyValueSpecification<number>
    "line-dasharray"?: PropertyValueSpecification<Array<number>>
    "line-pattern"?: DataDrivenPropertyValueSpecification<ResolvedImageSpecification>
    "line-gradient"?: ExpressionSpecification
}

export type CaseSpecification = (string|number|(boolean|string|string[])[])[]

export type PaintSpecification = FillPaintSpecification | LinePaintSpecification

//==============================================================================

export interface BaseLayerStyle
{
    id: string
    maxzoom?: number
    minzoom?: number
}

export interface VectorLayerStyle extends BaseLayerStyle
{
    source: string
    'source-layer'?: string
}

//==============================================================================

export class StyleLayer
{
    #id: string

    constructor(id: string)
    {
        this.#id = id
    }

    get id(): string
    {
        return this.#id
    }

    style(layer: FlatMapLayer|null, _options: StylingOptions={}): BaseLayerStyle
    {
        const style = {
            'id': this.#id
        }
        if (layer) {
            if ('min-zoom' in layer) {
                style['minzoom'] = layer['min-zoom']
            }
            if ('max-zoom' in layer) {
                style['maxzoom'] = layer['max-zoom']
            }
        }
        return style
    }
}

//==============================================================================

export class VectorStyleLayer extends StyleLayer
{
    #lastPaintStyle: PaintSpecification
    #sourceLayer: string

    constructor(id: string, suffix: string, sourceLayer: string)
    {
        super(`${id}_${suffix}`)
        this.#sourceLayer = sourceLayer
        this.#lastPaintStyle = {}
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return null
    }

    paintStyle(_options: StylingOptions, _changes: boolean=false): PaintSpecification
    {
        return {}
    }

    #paintChanges(newPaintStyle: PaintSpecification): PaintSpecification
    {
        const paintChanges: PaintSpecification = {}
        for (const [property, value] of Object.entries(newPaintStyle)) {
            if (!(property in this.#lastPaintStyle)
             || JSON.stringify(value) !== JSON.stringify(this.#lastPaintStyle[property])) {
                paintChanges[property] = value
            }
        }
        return paintChanges
    }

    changedPaintStyle(newPaintStyle: PaintSpecification, changes: boolean=false): PaintSpecification
    {
        const paintStyle = changes ? this.#paintChanges(newPaintStyle) : newPaintStyle
        this.#lastPaintStyle = newPaintStyle
        return paintStyle
    }

    style(layer: FlatMapLayer, options?: StylingOptions): VectorLayerStyle
    {
        return {
            ...super.style(layer, options),
            'source': VECTOR_TILES_SOURCE,
            'source-layer': this.#sourceLayer
        }
    }
}

//==============================================================================

export class BodyStyleLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'body', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['any', ['==', ['get', 'models'], 'UBERON:0013702'],
                    ['==', ['get', 'kind'], 'background']],
        ]
    }

    style(layer: FlatMapLayer, options: StylingOptions): FillLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'fill',
            'filter': this.defaultFilter(),
            'paint': {
                'fill-color': [
                    'case',
                    ['has', 'colour'], ['get', 'colour'],
                    '#CCC'
                ],
                'fill-opacity': [
                    'case',
                    ['has', 'colour'], 1.0,
                    0.1
                ]
            }
        }
    }
}

//==============================================================================

export class BackgroundBorderLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'background-border', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['==', ['get', 'kind'], 'background']
        ]
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint': {
                'line-color': '#666',
                'line-width': 6
            }
        }
    }
}

//==============================================================================

export class FeatureFillLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'fill', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['!=', ['get', 'models'], 'UBERON:0013702'],
            ['!=', ['get', 'kind'], 'background'],
            ['!', ['has', 'node']]
        ]
    }

    paintStyle(options: StylingOptions, changes=false)
    {
        const coloured = !('coloured' in options) || options.coloured
        const outlined = !('outlined' in options) || options.outlined
        const dimmed = options.dimmed || false
        const functional = (options.flatmapStyle === FLATMAP_STYLE.FUNCTIONAL)

        // @ts-expect-error None
        const noOutlineActive: [ExpressionSpecification] = (coloured || outlined) ? []
                                         : [['boolean', ['feature-state', 'active'], false], '#444']
        const paintStyle: PaintSpecification = {
            'fill-color': [
                'case',
                ['boolean', ['feature-state', 'selected'], false], functional ? '#CCC' : COLOUR_SELECTED,
                ...noOutlineActive,
                ['boolean', ['feature-state', 'hidden'], false], COLOUR_HIDDEN,
                ['has', 'colour'], ['get', 'colour'],
                ['==', ['get', 'kind'], 'proxy'], '#F88',
                ['all',
                    ['==', ['case', ['has', 'shape-type'], ['get', 'shape-type'], 'component'], 'component'],
                    ['boolean', ['feature-state', 'active'], false]
                ], (coloured && !functional) ? '#D88' : '#DDD',
                (coloured ? 'white' : '#CCC')
            ],
            'fill-opacity': [
                'case',
                ['boolean', ['feature-state', 'hidden'], false], 0.01,
                ['boolean', ['feature-state', 'selected'], false], functional ? 0.6 : 1.0,
                ['has', 'opacity'], ['get', 'opacity'],
                ['has', 'colour'], 1.0,
                ['==', ['get', 'kind'], 'proxy'], 1.0,
                ['all',
                    ['==', ['case', ['has', 'shape-type'], ['get', 'shape-type'], 'component'], 'component'],
                    ['boolean', ['feature-state', 'active'], false]
                ], functional ? 0.1 : 0.7,
                (coloured ? (!dimmed ? 0.01 : 0.1) : 0.4)
            ]
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): FillLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'fill',
            'filter': this.defaultFilter(),
            'layout': {
                'fill-sort-key': ['get', 'scale']
            },
            'paint': this.paintStyle(options) as FillPaintSpecification
        }
    }
}

//==============================================================================

export class FeatureBorderLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'border', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['!', ['has', 'node']]
        ]
    }

    paintStyle(options: StylingOptions, changes=false)
    {
        const outlined = !('outlined' in options) || options.outlined
        const dimmed = options.dimmed || false
        const activeRasterLayer = options.activeRasterLayer || false
        const functional = (options.flatmapStyle === FLATMAP_STYLE.FUNCTIONAL)

        const lineColour: CaseSpecification = ['case']
        lineColour.push(['boolean', ['feature-state', 'hidden'], false], COLOUR_HIDDEN)
        lineColour.push(['boolean', ['feature-state', 'active'], false], COLOUR_ACTIVE)
        lineColour.push(['boolean', ['feature-state', 'selected'], false], functional ? '#F80' : FEATURE_SELECTED_BORDER)
        lineColour.push(['boolean', ['feature-state', 'annotated'], false], COLOUR_ANNOTATED)
        lineColour.push(['has', 'stroke'], ['get', 'stroke'])
        lineColour.push(['has', 'colour'], ['get', 'colour'])
        lineColour.push('#444')

        const lineOpacity: CaseSpecification = ['case']
        lineOpacity.push(['boolean', ['feature-state', 'hidden'], false], 0.05)
        if (outlined) {
            lineOpacity.push(['boolean', ['feature-state', 'active'], false], 0.9)
        }
        lineOpacity.push(['boolean', ['feature-state', 'selected'], false], 0.9)
        lineOpacity.push(['boolean', ['feature-state', 'annotated'], false], 0.9)
        if (options.hasImageLayers) {
            lineOpacity.push(['has', 'shape-type'], 0)
        }
        if (activeRasterLayer) {
            lineOpacity.push((outlined && !dimmed) ? 0.3 : 0.1)
        } else {
            lineOpacity.push(0.5)
        }

        const width: CaseSpecification = ['case']
        width.push(['boolean', ['get', 'invisible'], false], 0.2)
        width.push(['boolean', ['feature-state', 'selected'], false], 2)
        if (outlined) {
            width.push(['boolean', ['feature-state', 'active'], false], 1.5)
        }
        width.push(['boolean', ['feature-state', 'annotated'], false], 3.5)
        width.push(['has', 'colour'], 0.7)
        width.push(functional ? 1 : outlined ? 0.5 : 0.1)
        const lineWidth = uniformZoomScaling(
            [
                '*',
                ['case',
                    ['has', 'stroke-width'], ['get', 'stroke-width'],
                    1.0
                ],
                0.7,
                width as ExpressionSpecification
            ]
        )
        return super.changedPaintStyle(<PaintSpecification>{
            'line-color': lineColour,
            'line-opacity': lineOpacity,
            'line-width': lineWidth
        }, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint': this.paintStyle(options) as LinePaintSpecification
        }
    }
}

//==============================================================================

export class FeatureLineLayer extends VectorStyleLayer
{
    #dashed: boolean

    constructor(id: string, sourceLayer: string, options: StyleLayerOptions={})
    {
        const dashed = !!options.dashed
        super(id, `feature-${dashed ? 'line-dash' : 'line'}`, sourceLayer)
        this.#dashed = dashed
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'LineString'],
            this.#dashed ? ['==', ['get', 'type'], 'line-dash']
                          : [ 'any',
                              ['==', ['get', 'type'], 'bezier'],
                              ['==', ['get', 'type'], 'line']]
        ]
    }

    paintStyle(options: StylingOptions, changes=false)
    {
        const coloured = !('coloured' in options) || options.coloured
        const paintStyle: PaintSpecification = {
            'line-color': [
                'case',
                ['boolean', ['feature-state', 'hidden'], false], COLOUR_HIDDEN,
                ['boolean', ['feature-state', 'selected'], false], COLOUR_SELECTED,
                ['boolean', ['feature-state', 'active'], false], coloured ? '#888' : '#CCC',
                ['has', 'colour'], ['get', 'colour'],
                ['==', ['get', 'type'], 'network'], '#AFA202',
                options.authoring ? '#C44' : '#444'
            ],
            'line-opacity': [
                'case',
                    ['boolean', ['feature-state', 'hidden'], false], 0.01,
                    ['boolean', ['feature-state', 'selected'], false], 1.0,
                    ['has', 'colour'], 1.0,
                    ['boolean', ['feature-state', 'active'], false], 1.0,
                    0.3
                ],
            'line-width': uniformZoomScaling(
                [
                    '*',
                    ['case',
                        ['has', 'stroke-width'], ['get', 'stroke-width'],
                        1.0
                    ],
                    ['case',
                        ['boolean', ['feature-state', 'selected'], false], 1,
                        ['boolean', ['feature-state', 'active'], false], 1,
                        options.authoring ? 0.7 : 0.5
                    ]
                ]
            ),
            // Need to vary opacity based on zoom??
        }
        if (this.#dashed) {
            paintStyle['line-dasharray'] = [3, 2]
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint': this.paintStyle(options) as LinePaintSpecification
        }
    }
}

//==============================================================================

export class FeatureDashLineLayer extends FeatureLineLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, sourceLayer, {dashed: true})
    }
}

//==============================================================================

function sckanFilter(options: StylingOptions={}): ExpressionFilterSpecification
{
    const sckanState = (options.sckan || 'all').toLowerCase()
    if        (sckanState === 'none') {
        return ['!', ['has', 'sckan']]
    } else if (sckanState === 'valid') {
        return [
            'any',
            ['!', ['has', 'sckan']],
            [
                'all',
                ['has', 'sckan'],
                ['==', ['get', 'sckan'], true]
            ]
        ]
    } else if (sckanState === 'invalid') {
        return [
            'any',
            ['!', ['has', 'sckan']],
            [
                'all',
                ['has', 'sckan'],
                ['!=', ['get', 'sckan'], true]
            ]
        ]
    } else {
        return true
    }
}

function zoomBoundCaseExpression(zoomValue: number, inRangeOpacity: number, outOfRangeOpacity: number): any
{
    const expression: any[] = ['case']
    expression.push(['==', ['get', 'type'], 'bezier'], 1.0)
    expression.push(['==', ['get', 'kind'], 'error'], 1.0)
    expression.push(['boolean', ['feature-state', 'selected'], false], 0.0)
    expression.push(['boolean', ['feature-state', 'active'], false], 0.0)
    expression.push(['<', zoomValue, ['to-number', ['coalesce', ['get', 'minzoom'], 0], 0]], outOfRangeOpacity)
    expression.push(['>', zoomValue, ['to-number', ['coalesce', ['get', 'maxzoom'], 24], 24]], outOfRangeOpacity)
    expression.push(inRangeOpacity)
    return expression
}

function extentOpacityExpression(dimmed: boolean, normalOpacity: number, fadedOpacity: number,
                                 pathLowDensityMode=false): any
{
    const inRangeOpacity = dimmed ? fadedOpacity : normalOpacity
    const outOfRangeOpacity = pathLowDensityMode ? inRangeOpacity : fadedOpacity
    const expression: any[] = ['step', ['zoom'],
        zoomBoundCaseExpression(0, inRangeOpacity, outOfRangeOpacity)]
    for (let step = 1; step <= 24; step++) {
        expression.push(step)
        expression.push(zoomBoundCaseExpression(step, inRangeOpacity, outOfRangeOpacity))
    }
    return expression
}

//==============================================================================

export class AnnotatedPathLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'annotated-path', sourceLayer)
    }

    defaultFilter(options: StylingOptions={}): ExpressionFilterSpecification
    {
        return [
            'all',
            ...[sckanFilter(options)]
        ]
    }

    paintStyle(options: StylingOptions={}, changes=false)
    {
        const dimmed = options.dimmed || false
        const exclude = options.excludeAnnotated || false
        const paintStyle: PaintSpecification = {
            'line-color': COLOUR_ANNOTATED,
            'line-dasharray': [5, 0.5, 3, 0.5],
            'line-opacity': [
                'case',
                    ['boolean', ['feature-state', 'active'], false], 0.8,
                    ['boolean', ['feature-state', 'selected'], false], 0.8,
                    ['boolean', ['feature-state', 'hidden'], false], 0.05,
                    ['boolean', ['feature-state', 'annotated'], false],
                        ((exclude || dimmed) ? 0.05 : 0.8),
                    0.6
                ],
            'line-width': uniformZoomScaling(
                [
                    'case',
                    ['boolean', ['feature-state', 'hidden'], false], 0.0,
                    ['boolean', ['feature-state', 'annotated'], false],
                        exclude ? 0.0 : (['*', 1.1, ['case',
                            ['has', 'stroke-width'], ['get', 'stroke-width'],
                            ['boolean', ['feature-state', 'active'], false], 1.1,
                            ['boolean', ['feature-state', 'active'], false], 1.1,
                            1.0]]),
                        0.0

                ]
            )
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(options),
            'paint': this.paintStyle(options) as LinePaintSpecification,
            'layout': {
                'line-cap': 'square'
            }
        }
    }
}

//==============================================================================

export class PathLineLayer extends VectorStyleLayer
{
    #dashed: boolean
    #highlight: boolean

    constructor(id: string, sourceLayer: string, options: StyleLayerOptions={})
    {
        const dashed = !!(options.dashed || false)
        const highlight = !!('highlight' in options && options.highlight)
        super(id, `path${highlight ? '-highlight' : ''}-${dashed ? 'line-dash' : 'line'}`, sourceLayer)
        this.#dashed = dashed
        this.#highlight = highlight
    }

    defaultFilter(options: StylingOptions={}): ExpressionFilterSpecification
    {
        const sckan_filter = sckanFilter(options)
        return this.#dashed ? [
            'all',
            ['==', ['get', 'type'], 'line-dash'],
            ...[sckan_filter]
        ] : [
            'all',
            [
                'any',
                ['==', ['get', 'type'], 'bezier'],
                [
                    'all',
                    ['==', ['get', 'type'], 'line'],
                    ...[sckan_filter]
                ]
            ]
        ]
    }

    paintStyle(options: StylingOptions={}, changes=false)
    {
        const dimmed = options.dimmed || false
        const exclude = 'excludeAnnotated' in options && options.excludeAnnotated
        const pathLowDensityMode = options.pathLowDensityMode || false
        const paintStyle: PaintSpecification = {
            'line-color': [
                'let', 'active', ['to-number', ['feature-state', 'active'], 0],
                [ 'case',
                    ['==', ['get', 'type'], 'bezier'], 'red',
                    // @ts-expect-error 2322
                    ...PATH_STYLE_RULES, '#888'
                ]
            ],
            'line-opacity': this.#highlight ? [
                'case',
                    ['boolean', ['feature-state', 'selected'], false], 1.0,
                    ['boolean', ['feature-state', 'active'], false], 1.0,
                0.0
            ] : extentOpacityExpression(dimmed, 0.8, 0.1, pathLowDensityMode),
            'line-width': uniformZoomScaling(
                [
                    "*",
                    this.#highlight ? ['case',
                        ['boolean', ['feature-state', 'selected'], false], [
                            'case', ['boolean', ['feature-state', 'active'], false], 2.0,
                                0.9],
                        ['boolean', ['feature-state', 'active'], false], 1.8,
                        0.0
                    ] : [
                     'case',
                        ['==', ['get', 'type'], 'bezier'], 0.1,
                        ['==', ['get', 'kind'], 'error'], 1,
                        ['==', ['get', 'kind'], 'unknown'], 1,
                        ['boolean', ['get', 'invisible'], false], 0.1,
                        ['boolean', ['feature-state', 'selected'], false], 0.0,
                        ['boolean', ['feature-state', 'active'], false], 0.0,
                        0.6
                    ],
                    ['case', ['boolean', ['feature-state', 'annotated'], false], (exclude ? 0.0 : 1.0), 1.0],
                    ['case', ['has', 'stroke-width'], ['get', 'stroke-width'], 1.0]
                ]
            )
        }
        if (this.#dashed) {
            paintStyle['line-dasharray'] = [1, 1]
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions={}): LineLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(options),
            'layout': {
                'line-cap': 'butt'
            },
            'paint': this.paintStyle(options) as LinePaintSpecification
        }
    }
}

//==============================================================================

export class PathDashlineLayer extends PathLineLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, sourceLayer, {dashed: true})
    }
}

//==============================================================================

export class PathHighlightLayer extends PathLineLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, sourceLayer, {highlight: true})
    }
}

export class PathDashHighlightLayer extends PathLineLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, sourceLayer, {dashed: true, highlight: true})
    }
}

//==============================================================================

class NerveCentrelineLayer extends VectorStyleLayer
{
    #type: string

    constructor(id: string, type: string, sourceLayer: string)
    {
        super(id, `nerve-centreline-${type}`, sourceLayer)
        this.#type = type
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'LineString'],
            ['==', ['get', 'kind'], 'centreline'],
        ]
    }

    paintStyle(_options: StylingOptions, changes=false)
    {
        const paintStyle: PaintSpecification = {
            'line-color': (this.#type === 'edge') ? [
                'case', ['all',
                    ['boolean', ['feature-state', 'active'], false],
                    ['boolean', ['feature-state', 'selected'], false]
                ], COLOUR_SELECTED,
                '#000'
            ] : [
                'case',
                ['boolean', ['feature-state', 'active'], false], CENTRELINE_ACTIVE,
                ['boolean', ['feature-state', 'selected'], false], COLOUR_SELECTED,
                CENTRELINE_COLOUR
            ],
            'line-opacity': [
                'case',
                    ['boolean', ['feature-state', 'selected'], false], 1.0,
                    ['boolean', ['feature-state', 'active'], false], 1.0,
                (this.#type === 'edge') ? 0.4 : 0.7
            ],
            'line-width': uniformZoomScaling((this.#type === 'edge') ? 4 : 3)
            // Need to vary opacity based on zoom??
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint': this.paintStyle(options) as LinePaintSpecification,
            'layout': {
                'line-cap': 'round',
                'line-join': 'bevel'
            }
        }
    }
}


export class NerveCentrelineEdgeLayer extends NerveCentrelineLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'edge', sourceLayer)
    }
}

export class NerveCentrelineTrackLayer extends NerveCentrelineLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'track', sourceLayer)
    }
}

//==============================================================================

export class CentrelineNodeFillLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'node-fill', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['has', 'node']
        ]
    }

    paintStyle(options: StylingOptions={}, changes=false)
    {
        const showNodes = options.showNerveCentrelines || false
        const paintStyle: PaintSpecification = {
                'fill-color': [
                    'case',
                    ['boolean', ['feature-state', 'selected'], false], COLOUR_SELECTED,
                    ['boolean', ['feature-state', 'active'], false], CENTRELINE_ACTIVE,
                    CENTRELINE_COLOUR
                ],
                'fill-opacity': showNodes ? 0.8 : 0
            }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): FillLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'fill',
            'filter': this.defaultFilter(),
            'layout': {
                'fill-sort-key': ['get', 'scale']
            },
            'paint': this.paintStyle(options) as FillPaintSpecification
        }
    }
}

export class CentrelineNodeBorderLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'node-border', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['has', 'node']
        ]
    }

    paintStyle(options: StylingOptions={}, changes=false)
    {
        const showNodes = options.showNerveCentrelines || false
        const paintStyle: PaintSpecification = {
            'line-color': '#000',
            'line-opacity': showNodes ? 0.1 : 0,
            'line-width': uniformZoomScaling(0.2)
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions)
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint':  this.paintStyle(options) as LinePaintSpecification
        }
    }
}

//==============================================================================

export class FeatureNerveLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'nerve-path', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'LineString'],
            ['!=', ['get', 'kind'], 'centreline'],
            ['==', ['get', 'type'], 'nerve']
        ]
    }

    paintStyle(options: StylingOptions, changes=false) {
        const dimmed = options.dimmed || false
        const paintStyle: PaintSpecification = {
            'line-color': [
                'case',
                ['boolean', ['feature-state', 'hidden'], false], COLOUR_HIDDEN,
                ['boolean', ['feature-state', 'active'], false], NERVE_ACTIVE,
                ['boolean', ['feature-state', 'selected'], false], NERVE_SELECTED,
                '#888'
            ],
            'line-opacity': [
                'case',
                ['boolean', ['feature-state', 'hidden'], false], 0.3,
                ['boolean', ['get', 'invisible'], false], 0.001,
                ['boolean', ['feature-state', 'active'], false], 0.9,
                ['boolean', ['feature-state', 'selected'], false], 0.9,
                dimmed ? 0.05 : 0.9
            ],
            'line-dasharray': [2, 2],
            'line-width': [
                'case',
                ['boolean', ['feature-state', 'selected'], false], 1.5,
                ['boolean', ['feature-state', 'active'], false], 1.5,
                dimmed ? 0.2 : 1.5
            ]
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint': this.paintStyle(options) as LinePaintSpecification
        }
    }
}

//==============================================================================

export class NervePolygonBorder extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'nerve-border', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['==', ['get', 'type'], 'nerve-section']
        ]
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint': {
                'line-color': [
                    'case',
                    ['boolean', ['feature-state', 'active'], false], COLOUR_ACTIVE,
                    ['boolean', ['feature-state', 'selected'], false], 'red',
                    '#444'
                ],
                'line-opacity': [
                    'case',
                    ['boolean', ['get', 'invisible'], false], 0.05,
                    ['boolean', ['feature-state', 'active'], false], 0.9,
                    ['boolean', ['feature-state', 'selected'], false], 0.9,
                    0.3
                ],
                'line-width': [
                    'case',
                    ['boolean', ['get', 'invisible'], false], 0.5,
                    ['boolean', ['feature-state', 'selected'], false], 6,
                    2
                ]
            }
        }
    }
}

//==============================================================================

export class NervePolygonFill extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'nerve-fill', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['any',
                ['==', ['get', 'type'], 'arrow'],
                ['==', ['get', 'type'], 'bezier'],
                ['==', ['get', 'type'], 'junction'],
                ['==', ['get', 'type'], 'nerve'],
                ['==', ['get', 'type'], 'nerve-section']
            ]
        ]
    }

    paintStyle(options: StylingOptions={}, changes=false)
    {
        const dimmed = options.dimmed || false
        const paintStyle: PaintSpecification = {
            'fill-color': [
                'case',
                ['boolean', ['feature-state', 'selected'], false], COLOUR_SELECTED,
                ['all',
                    ['==', ['case', ['has', 'shape-type'], ['get', 'shape-type'], 'component'], 'component'],
                    ['boolean', ['feature-state', 'active'], false]
                ], '#D88',
                ['has', 'colour'], ['get', 'colour'],
                ['==', ['get', 'kind'], 'bezier-end'], 'red',
                ['==', ['get', 'kind'], 'bezier-control'], 'green',
                // @ts-expect-error 2322
                ...PATH_STYLE_RULES, '#00A0FF'
            ],
            'fill-opacity': [
                'case',
                ['boolean', ['feature-state', 'hidden'], false], 0.01,
                ['boolean', ['feature-state', 'selected'], false], 1,
                ['has', 'opacity'], ['get', 'opacity'],
                ['has', 'colour'], 1.0,
                ['==', ['get', 'kind'], 'proxy'], 1.0,
                ['all',
                    ['==', ['case', ['has', 'shape-type'], ['get', 'shape-type'], 'component'], 'component'],
                    ['boolean', ['feature-state', 'active'], false]
                ], 0.7,
                ['any',
                    ['==', ['get', 'type'], 'arrow'],
                    ['==', ['get', 'type'], 'junction']
                ], dimmed ? 0.1 : 0.5,
                dimmed ? 0.2 : 0.5
            ]
        }
        return super.changedPaintStyle(paintStyle, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions={}): FillLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'filter': this.defaultFilter(),
            'type': 'fill',
            'paint': this.paintStyle(options) as FillPaintSpecification
        }
    }
}

//==============================================================================

export class FeatureZoomPointLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'zoom-point', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Point'],
            ['==', ['get', 'kind'], 'zoom-point'],
            ['has', 'details-layer']
        ]
    }

    style(layer: FlatMapLayer, options: StylingOptions): SymbolLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'symbol',
            'filter': this.defaultFilter(),
            'layout': {
                'visibility': 'visible',
                'icon-allow-overlap': true,
                'icon-image': 'zoom-marker',
                'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.1, 3, 0.01, 9, 2],
            }
        }
    }
}

export class MultipaneZoomPointLayer extends FeatureZoomPointLayer
{
    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Point'],
            ['==', ['get', 'kind'], 'zoom-point']
        ]
    }
}

//==============================================================================

export class FeatureLargeSymbolLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'large-symbol', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['has', 'labelled'],
            ['has', 'label']
        ]
    }

    style(layer: FlatMapLayer, options: StylingOptions): SymbolLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'symbol',
            'minzoom': 3,
            //'maxzoom': 7,
            'filter': this.defaultFilter(),
            'layout': {
                'visibility': 'visible',
                'icon-allow-overlap': true,
                'icon-image': 'label-background',
                'text-allow-overlap': true,
                'text-field': '{label}',
                'text-font': ['Open Sans Semibold'],
                'text-line-height': 1,
                'text-max-width': 5,
                'text-size': 16,
                'icon-text-fit': 'both'
            },
            'paint': {
                'text-color': [
                    'case',
                    ['boolean', ['feature-state', 'active'], false], '#8300bf',
                    '#000'
                ]
            }
        }
    }
}

//==============================================================================

export class FeatureSmallSymbolLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'small-symbol', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['has', 'label'],
            ['>', ['get', 'scale'], 5]
        ]
    }

    style(layer: FlatMapLayer, options: StylingOptions): SymbolLayerSpecification
    {
        return {
            ...super.style(layer, options),
            'type': 'symbol',
            'minzoom': 6,
            'filter': this.defaultFilter(),
            'layout': {
                'visibility': 'visible',
                'icon-allow-overlap': true,
                'icon-image': 'label-background',
                'text-allow-overlap': true,
                'text-field': '{label}',
                'text-font': ['Open Sans Semibold'],
                'text-line-height': 1,
                'text-max-width': 5,
                'text-size': ['step', ['zoom'], 8, 5, 12, 7, 16, 9, 20],
                'icon-text-fit': 'both'
            },
            'paint': {
                'text-color': [
                    'case',
                    ['boolean', ['feature-state', 'active'], false], '#8300bf',
                    '#000'
                ]
            }
        }
    }
}

//==============================================================================

export class BackgroundStyleLayer extends StyleLayer
{
    constructor()
    {
        super('background')
    }

    style(_, options: StylingOptions): BackgroundLayerSpecification
    {
        return {
            ...super.style(null, {}),
            'type': 'background',
            'paint': {
                'background-color': options.colour,
                'background-opacity': options.opacity || 1.0
            }
        }
    }
}

//==============================================================================

export class RasterStyleLayer extends StyleLayer
{
    #options: StyleLayerOptions

    constructor(id: string, options: StyleLayerOptions={})
    {
        super(id)
        this.#options = options
    }

    style(layer: FlatMapLayer, options: StylingOptions): RasterLayerSpecification
    {
        const coloured = !('coloured' in options) || options.coloured
        const anatomical = (options.flatmapStyle === FLATMAP_STYLE.ANATOMICAL)
        const style: RasterLayerSpecification = {
            ...super.style(layer),
            source: this.id,
            type: 'raster',
            layout: {
                'visibility': coloured ? 'visible' : 'none'
            }
        }
        if ('detail-layer' in this.#options && this.#options['detail-layer']) {
            style['minzoom'] = this.#options['min-zoom']
            style['maxzoom'] = this.#options['max-zoom']
            const fullOpacity = Math.min(this.#options['max-zoom'],
                                         this.#options['min-zoom'] + DETAIL_ZOOM_OFFSET)
            const stops = anatomical
                ? [
                    this.#options['min-zoom'] + 2, 0.1,
                    fullOpacity, 1
                ]
                : [
                    fullOpacity, 1
                ];

            style['paint'] = {
                'raster-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    this.#options['min-zoom'], 0,
                    ...stops
                ]
            }
        }
        return style
    }
}

//==============================================================================
//==============================================================================

export class HighlightVariablesLayer extends VectorStyleLayer
{
    constructor(id: string, sourceLayer: string)
    {
        super(id, 'variables', sourceLayer)
    }

    defaultFilter(): ExpressionFilterSpecification
    {
        return [
            'all',
            ['==', ['geometry-type'], 'Polygon'],
            ['!', ['has', 'node']]
        ]
    }

    paintStyle(options: StylingOptions, changes=false)
    {
        return super.changedPaintStyle(<PaintSpecification>{
            'line-color': '#00FF00',
            'line-opacity': [
                'case',
                [
                    'all',
                    ['boolean', ['feature-state', 'active'], false],
                    [
                        'any',
                        ['has', 'variable'],
                        [
                            'all',
                            ['has', 'associatedVariables'],
                            ['!=',
                                ['coalesce',
                                    ['at', 0, ['get', 'associatedVariables']],
                                    ''
                                ],
                                ''
                            ]
                        ]
                    ]
                ], 0.6,
                0.0
            ],
            'line-width': uniformZoomScaling(options.flatmapStyle === FLATMAP_STYLE.FUNCTIONAL ? 8 : 4)
        }, changes)
    }

    style(layer: FlatMapLayer, options: StylingOptions): LineLayerSpecification
    {
        return {
            ...super.style(layer),
            'type': 'line',
            'filter': this.defaultFilter(),
            'paint': this.paintStyle(options) as LinePaintSpecification
        }
    }
}

//==============================================================================
//==============================================================================
