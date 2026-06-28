export type Role = 'owner' | 'member'

export type Space = {
    id: string
    name: string
    created_by: string
    created_at: string
}

export type Membership = {
    space_id: string
    user_id: string
    role: Role
    created_at: string
}

export type Notification = {
    id: string
    space_id: string
    user_id: string
    type: string
    payload_json: Record<string, unknown>
    read_at: string | null
    created_at: string
    updated_at: string
}

export type User = { id: string; email?: string | null }

export type AuthStore = {
    getUser(): Promise<User | null>
    signInMagicLink(email: string): Promise<void>
    signOut(): Promise<void>
}

export type CoreStore = {
    ensurePersonalSpace(): Promise<{ space: Space; membership: Membership }>
    listNotifications(spaceId: string): Promise<Notification[]>
    markNotificationRead(id: string): Promise<void>
}

export type Backend = {
    auth: AuthStore
    core: CoreStore
}
