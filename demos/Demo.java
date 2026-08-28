// Demo.java — sample buggy Java for the EduPeer demonstration.
// Each method has a classic beginner mistake for the tutor to nudge you about.

public class Demo {

    static int add(int a, int b) {
        return a - b;
    }

    static double average(int[] numbers) {
        int total = 0;
        for (int i = 1; i < numbers.length; i++) {
            total = total + numbers[i];
        }
        return total / numbers.length;
    }

    static boolean sameWord(String a, String b) {
        return a == b;
    }

    public static void main(String[] args) {
        System.out.println(add(2, 3));
        System.out.println(average(new int[] { 10, 20, 30 }));
        System.out.println(sameWord("hi", new String("hi")));
    }
}
