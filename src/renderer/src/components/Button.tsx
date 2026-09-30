import { forwardRef, type ButtonHTMLAttributes } from 'react'
import './button.css'

type Variant = 'primary' | 'quiet' | 'danger'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }>(
  function Button({ variant = 'quiet', className, type = 'button', ...rest }, ref) {
    return (
      <button ref={ref} type={type} className={`btn btn-${variant}${className ? ` ${className}` : ''}`} {...rest} />
    )
  }
)
