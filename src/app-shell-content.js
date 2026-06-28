export const TEMPLATE_CHECKS = [
    'Define PROJECT_NAME, PRIMARY_GOAL y contratos base en discipline.md.',
    'Cierra Slice 0: instala el SDK del provider elegido y pasa backend:smoke.',
    'Reemplaza iconos, nombre de app y manifest antes del primer deploy.',
]

export const TEMPLATE_STRENGTHS = [
    {
        title: 'Contracts First',
        description:
            'La shell ya está alineada para empezar por datos, estados y DoD antes de escribir lógica de negocio.',
    },
    {
        title: 'Backend Factory',
        description:
            'El adapter común te deja cambiar de provider sin reescribir la superficie principal de la app.',
    },
    {
        title: 'PWA Ready',
        description:
            'Manifest, service worker y layout base ya existen para que el primer vertical slice sea desplegable.',
    },
]

export const TEMPLATE_STATE_CARDS = [
    {
        state: 'loading',
        title: 'Loading',
        description: 'Usa skeleton, copy breve y evita parpadeo mientras el source of truth responde.',
    },
    {
        state: 'empty',
        title: 'Empty',
        description: 'El primer uso explica qué falta crear y cuál es la siguiente acción segura.',
    },
    {
        state: 'error',
        title: 'Error',
        description: 'Todo fallo debe tener recovery claro, retry manual y mensaje accionable.',
    },
    {
        state: 'normal',
        title: 'Normal',
        description: 'El flujo principal solo aparece cuando contratos, provider y estados base ya están listos.',
    },
]
