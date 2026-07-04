export const TEMPLATE_CHECKS = [
    'Define PROJECT_NAME, PRIMARY_GOAL, and base contracts in discipline.md.',
    'Close Slice 0: install the selected provider SDK and pass backend:smoke.',
    'Replace icons, app name, and manifest before the first deploy.',
]

export const TEMPLATE_STRENGTHS = [
    {
        title: 'Contracts First',
        description:
            'The shell is already aligned to start from data, states, and DoD before writing business logic.',
    },
    {
        title: 'Backend Factory',
        description:
            'The shared adapter lets you switch providers without rewriting the main app surface.',
    },
    {
        title: 'PWA Ready',
        description:
            'Manifest, service worker, and base layout already exist so the first vertical slice can be deployed.',
    },
]

export const TEMPLATE_STATE_CARDS = [
    {
        state: 'loading',
        title: 'Loading',
        description: 'Use a skeleton, brief copy, and avoid flicker while the source of truth responds.',
    },
    {
        state: 'empty',
        title: 'Empty',
        description: 'The first-use state explains what is missing and the next safe action.',
    },
    {
        state: 'error',
        title: 'Error',
        description: 'Every failure needs clear recovery, manual retry, and an actionable message.',
    },
    {
        state: 'normal',
        title: 'Normal',
        description: 'The main flow appears only when contracts, provider, and base states are ready.',
    },
]
