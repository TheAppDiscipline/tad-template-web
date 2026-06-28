import type { Backend, Space, Membership, Notification, User } from '../types'
import { supabase } from './client'

export const backend: Backend = {
    auth: {
        async getUser(): Promise<User | null> {
            const { data } = await supabase.auth.getUser()
            return data.user ? { id: data.user.id, email: data.user.email } : null
        },
        async signInMagicLink(email: string) {
            const { error } = await supabase.auth.signInWithOtp({
                email,
                options: { emailRedirectTo: window.location.origin },
            })
            if (error) throw error
        },
        async signOut() {
            const { error } = await supabase.auth.signOut()
            if (error) throw error
        },
    },

    core: {
        async ensurePersonalSpace() {
            const { data: userData, error: userErr } = await supabase.auth.getUser()
            if (userErr) throw userErr
            const user = userData.user
            if (!user) throw new Error('Not authenticated')

            // 1) buscar un space "Personal" creado por el user (o el primero que tenga membership owner)
            const { data: existing, error: exErr } = await supabase
                .from('spaces')
                .select('id,name,created_by,created_at')
                .eq('created_by', user.id)
                .limit(1)
            if (exErr) throw exErr
            if (existing && existing.length > 0) {
                const space = existing[0] as Space
                // membership
                const { data: mem, error: memErr } = await supabase
                    .from('memberships')
                    .select('space_id,user_id,role,created_at')
                    .eq('space_id', space.id)
                    .eq('user_id', user.id)
                    .single()
                if (memErr) throw memErr
                return { space, membership: mem as Membership }
            }

            // 2) crear space + membership owner
            const { data: created, error: cErr } = await supabase
                .from('spaces')
                .insert({ name: 'Personal', created_by: user.id })
                .select('id,name,created_by,created_at')
                .single()
            if (cErr) throw cErr

            const { data: membership, error: mErr } = await supabase
                .from('memberships')
                .insert({ space_id: created.id, user_id: user.id, role: 'owner' })
                .select('space_id,user_id,role,created_at')
                .single()
            if (mErr) throw mErr

            return { space: created as Space, membership: membership as Membership }
        },

        async listNotifications(spaceId: string) {
            const { data, error } = await supabase
                .from('notifications')
                .select('*')
                .eq('space_id', spaceId)
                .order('created_at', { ascending: false })
                .limit(50)
            if (error) throw error
            return (data ?? []) as Notification[]
        },

        async markNotificationRead(id: string) {
            const { error } = await supabase
                .from('notifications')
                .update({ read_at: new Date().toISOString() })
                .eq('id', id)
            if (error) throw error
        },
    },
}
