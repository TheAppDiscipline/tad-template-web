import { createElement as h } from 'react'
import {
    TEMPLATE_CHECKS,
    TEMPLATE_STATE_CARDS,
    TEMPLATE_STRENGTHS,
} from './app-shell-content.js'

function renderMetaItem(label, value) {
    return h('div', { key: label }, [
        h('dt', { key: `${label}-label` }, label),
        h('dd', { key: `${label}-value` }, value),
    ])
}

function renderStrengthCard(item) {
    return h('article', { key: item.title, className: 'panel feature-card' }, [
        h('h2', { key: `${item.title}-title` }, item.title),
        h('p', { key: `${item.title}-description` }, item.description),
    ])
}

function renderStateCard(item) {
    return h('article', {
        key: item.state,
        className: `panel state-card state-${item.state}`,
        'data-state': item.state,
    }, [
        h('p', { key: `${item.state}-label`, className: 'state-label' }, item.title),
        h('p', { key: `${item.state}-description` }, item.description),
    ])
}

function renderChecklistItem(item) {
    return h('li', { key: item }, item)
}

export function AppShellView({ backendProvider, authMode, profile = 'LITE' }) {
    return h('main', { className: 'app-shell' }, [
        h('section', { key: 'hero', className: 'panel hero' }, [
            h('p', { key: 'eyebrow', className: 'eyebrow' }, 'Discipline Loop Factory Template'),
            h('h1', { key: 'title' }, 'Start from a Discipline Loop shell, not a demo counter.'),
            h('p', { key: 'copy', className: 'hero-copy' },
                'This repo is prepared for Slice 0: choose a provider, lock the contracts, and ship the first vertical slice with gates, logs, and PWA wiring already in place.'
            ),
            h('dl', { key: 'meta', className: 'hero-meta', 'aria-label': 'Current template defaults' }, [
                renderMetaItem('Backend', backendProvider),
                renderMetaItem('Auth', authMode),
                renderMetaItem('Profile', profile),
            ]),
        ]),
        h('section', { key: 'strengths', className: 'panel-grid', 'aria-label': 'Template strengths' },
            TEMPLATE_STRENGTHS.map(renderStrengthCard)
        ),
        h('section', { key: 'states', className: 'panel state-panel' }, [
            h('div', { key: 'state-copy', className: 'state-copy' }, [
                h('p', { key: 'state-eyebrow', className: 'eyebrow' }, 'UI State Model'),
                h('h2', { key: 'state-title' }, 'The shell already carries the four states Discipline Loop expects.'),
                h('p', { key: 'state-description' },
                    'Before your first async screen exists, the template should already remind the project that loading, empty, error, and normal are not optional states.'
                ),
            ]),
            h('div', { key: 'state-grid', className: 'state-grid', 'aria-label': 'Template state model' },
                TEMPLATE_STATE_CARDS.map(renderStateCard)
            ),
        ]),
        h('section', { key: 'checklist', className: 'panel checklist-panel' }, [
            h('div', { key: 'checklist-copy', className: 'checklist-copy' }, [
                h('p', { key: 'checklist-eyebrow', className: 'eyebrow' }, 'Slice 0 Checklist'),
                h('h2', { key: 'checklist-title' }, 'Use the template as infrastructure, then replace the shell with your app.'),
                h('p', { key: 'checklist-description' },
                    'The point of this screen is to give every new project a predictable starting point: no placeholder counter, no hidden setup, and no ambiguity about the next move.'
                ),
            ]),
            h('ol', { key: 'checklist-list', className: 'checklist' }, TEMPLATE_CHECKS.map(renderChecklistItem)),
        ]),
    ])
}
