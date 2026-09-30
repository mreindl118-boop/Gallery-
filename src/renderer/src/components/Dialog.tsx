import * as RD from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import './dialog.css'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 440
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
  width?: number
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="dialog-scrim" />
        <RD.Content className="dialog" style={{ width }}>
          <RD.Title className="dialog-title display">{title}</RD.Title>
          {description ? (
            <RD.Description className="dialog-description">{description}</RD.Description>
          ) : (
            <RD.Description className="visually-hidden">{title}</RD.Description>
          )}
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="dialog-actions">{children}</div>
}

export const DialogClose = RD.Close
