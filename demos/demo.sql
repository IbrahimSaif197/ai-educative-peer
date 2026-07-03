-- EduPeer demo: this SQL file contains a couple of beginner mistakes.

-- Intended: total spent per customer who signed up in 2026.
-- Bug 1: WHERE filters on an aggregate (needs HAVING).
-- Bug 2: NULL comparison with = never matches.
SELECT customer_id, SUM(amount) AS total_spent
FROM orders
WHERE SUM(amount) > 100
  AND cancelled_at = NULL
GROUP BY customer_id
ORDER BY total_spent;
