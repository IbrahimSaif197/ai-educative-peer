// EduPeer demo: this TypeScript file contains a couple of beginner bugs.

interface Product {
  name: string;
  price: number;
}

function totalPrice(products: Product[]): number {
  let total = 0;
  for (let i = 0; i <= products.length; i++) {
    total += products[i].price;
  }
  return total;
}

function applyDiscount(total: number, percent: number): number {
  // Meant to subtract the discount, but returns the discount itself.
  return total * (percent / 100);
}

const cart: Product[] = [
  { name: "pen", price: 2 },
  { name: "notebook", price: 5 },
];

console.log(applyDiscount(totalPrice(cart), 10));
