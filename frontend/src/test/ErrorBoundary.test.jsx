import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import ErrorBoundary from '../ErrorBoundary.jsx'

function Boom() {
  throw new Error('kaboom')
}

it('error boundary shows a readable fallback instead of a blank screen', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong in the page.')
  expect(screen.getByRole('alert')).toHaveTextContent('kaboom')
})
