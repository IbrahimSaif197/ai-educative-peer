// demo.js — sample buggy JavaScript for the EduPeer demonstration.
// Each function has a classic beginner mistake for the tutor to nudge you about.

function add(a, b) {
  return a - b;
}

function average(numbers) {
  let total = 0;
  for (let i = 1; i < numbers.length; i++) {
    total = total + numbers[i];
  }
  return total / numbers.length;
}

function isSame(a, b) {
  return a == b;
}

console.log(add(2, 3));
console.log(average([10, 20, 30]));
console.log(isSame("1", 1));
